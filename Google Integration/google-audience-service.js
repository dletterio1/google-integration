const { GoogleAdsApi } = require('google-ads-api');
const crypto = require('crypto');
const mongoose = require('mongoose');
const Customer = require('../../models/Customer.model');
const GoogleConnection = require('../../models/GoogleConnection.model');
const AuditLog = require('../../models/AuditLog.model');
const googleAuthService = require('./google-auth.service');
const encryptionService = require('../encryption.service');
const redis = require('../../config/redis');
const config = require('../../config/google-ads.config');
const { UserFriendlyError } = require('../../utils/errors');
const logger = require('../../utils/logger');
const Papa = require('papaparse');
const fs = require('fs').promises;

class GoogleAudienceService {
  constructor() {
    this.audienceCache = new Map();
    this.interestCache = new Map();
  }

  /**
   * Create a customer match audience from customer IDs
   * @param {Object} audienceData - Audience configuration
   * @param {String} organizationId - Organization ID
   * @param {String} userId - User creating the audience
   * @returns {Object} Created audience details
   */
  async createCustomerMatchAudience(audienceData, organizationId, userId) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      // Get authenticated client
      const { client, connection } = await this.getAuthenticatedClient(organizationId);

      // Get customers from database
      const customers = await Customer.find({
        _id: { $in: audienceData.customer_ids },
        _organization: organizationId,
        'marketingConsent.ads': true // Only include customers who consented
      }).select('email phone firstName lastName country zipCode');

      if (customers.length < 100) {
        throw new UserFriendlyError(
          'At least 100 customers with marketing consent are required for customer match',
          'INSUFFICIENT_CUSTOMERS',
          { found: customers.length, required: 100 }
        );
      }

      // Create user list in Google Ads
      const userListOperation = {
        create: {
          name: audienceData.name,
          description: audienceData.description || `Created from ${customers.length} customers`,
          membership_status: 'OPEN',
          membership_life_span: audienceData.retention_days || 30,
          crm_based_user_list: {
            upload_key_type: audienceData.upload_key_type || 'CONTACT_INFO',
            data_source_type: 'FIRST_PARTY'
          }
        }
      };

      const userListResponse = await client.userLists.mutate({
        customer_id: connection.customerId,
        operations: [userListOperation]
      });

      if (!userListResponse.results || userListResponse.results.length === 0) {
        throw new Error('Failed to create user list in Google Ads');
      }

      const userListResourceName = userListResponse.results[0].resource_name;
      const userListId = userListResourceName.split('/').pop();

      // Hash customer data for privacy
      const hashedCustomers = await this.hashCustomerData(customers);

      // Upload customers in batches
      const uploadResult = await this.uploadCustomersToList(
        client,
        connection.customerId,
        userListResourceName,
        hashedCustomers
      );

      // Create local record (you might want to create a GoogleAudience model)
      const audienceRecord = {
        _organization: organizationId,
        _created_by: userId,
        googleUserListId: userListId,
        googleResourceName: userListResourceName,
        name: audienceData.name,
        type: 'CUSTOMER_MATCH',
        size: customers.length,
        status: 'PROCESSING',
        retentionDays: audienceData.retention_days || 30,
        createdAt: new Date()
      };

      // Log audience creation
      await AuditLog.create({
        _organization: organizationId,
        _user: userId,
        action: 'google_audience_created',
        resource: 'GoogleAudience',
        resourceId: userListId,
        metadata: {
          audienceName: audienceData.name,
          customerCount: customers.length,
          uploadedCount: uploadResult.uploadedCount
        }
      });

      await session.commitTransaction();

      // Clear audience cache
      await redis.del(`google_audiences:${organizationId}:*`);

      logger.info('Google customer match audience created', {
        organizationId,
        userListId,
        customerCount: customers.length
      });

      return {
        success: true,
        audienceId: userListId,
        userListId: userListId,
        resourceName: userListResourceName,
        estimatedSize: customers.length,
        uploadedCount: uploadResult.uploadedCount,
        matchRate: uploadResult.matchRate || 'Pending'
      };

    } catch (error) {
      await session.abortTransaction();
      logger.error('Failed to create customer match audience', error);
      throw this.handleGoogleAdsError(error);
    } finally {
      session.endSession();
    }
  }

  /**
   * Create a lookalike audience
   * @param {String} sourceAudienceId - Source audience ID
   * @param {Object} lookalikeSpec - Lookalike configuration
   * @param {String} organizationId - Organization ID
   * @param {String} userId - User creating the audience
   * @returns {Object} Created lookalike details
   */
  async createLookalikeAudience(sourceAudienceId, lookalikeSpec, organizationId, userId) {
    try {
      // Get authenticated client
      const { client, connection } = await this.getAuthenticatedClient(organizationId);

      // Note: Google Ads uses "Similar Audiences" which are automatically created
      // from customer match lists. We'll create a placeholder and Google will
      // automatically generate similar audiences within 24-48 hours.

      const lookalikeOperation = {
        create: {
          name: lookalikeSpec.name || `Similar to ${sourceAudienceId}`,
          description: `${(lookalikeSpec.ratio * 100).toFixed(0)}% lookalike audience`,
          membership_status: 'OPEN',
          membership_life_span: 10000, // Maximum for lookalikes
          lookalike_user_list: {
            seed_user_list: `customers/${connection.customerId}/userLists/${sourceAudienceId}`,
            lookalike_expansion_level: this.mapRatioToExpansionLevel(lookalikeSpec.ratio),
            country_codes: [lookalikeSpec.country]
          }
        }
      };

      // Note: In production, Google automatically creates similar audiences
      // This is a placeholder for the expected behavior
      logger.info('Lookalike audience requested', {
        sourceAudienceId,
        country: lookalikeSpec.country,
        ratio: lookalikeSpec.ratio
      });

      // For now, return information about automatic similar audience creation
      return {
        success: true,
        audienceId: `pending_${sourceAudienceId}_similar`,
        userListId: `pending_${sourceAudienceId}_similar`,
        message: 'Google will automatically create similar audiences within 24-48 hours',
        estimatedReach: this.estimateLookalikeReach(lookalikeSpec.country, lookalikeSpec.ratio),
        country: lookalikeSpec.country
      };

    } catch (error) {
      logger.error('Failed to create lookalike audience', error);
      throw this.handleGoogleAdsError(error);
    }
  }

  /**
   * Get audiences for an organization
   * @param {String} organizationId - Organization ID
   * @param {Object} options - Query options
   * @returns {Object} Audiences and pagination
   */
  async getAudiences(organizationId, options = {}) {
    try {
      const { page = 1, limit = 20, type } = options;

      // Check cache
      const cacheKey = `google_audiences:${organizationId}:${page}:${limit}:${type || 'all'}`;
      const cached = await redis.get(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }

      // Get authenticated client
      const { client, connection } = await this.getAuthenticatedClient(organizationId);

      // Build GAQL query
      let query = `
        SELECT 
          user_list.id,
          user_list.name,
          user_list.description,
          user_list.membership_status,
          user_list.membership_life_span,
          user_list.size_for_display,
          user_list.size_for_search,
          user_list.type,
          user_list.creation_date_time
        FROM user_list
        WHERE user_list.membership_status != 'CLOSED'
      `;

      if (type === 'CUSTOMER_MATCH') {
        query += ` AND user_list.type = 'CRM_BASED'`;
      } else if (type === 'LOOKALIKE') {
        query += ` AND user_list.type = 'LOOKALIKE'`;
      }

      query += ' ORDER BY user_list.creation_date_time DESC';

      const response = await client.query({
        customer_id: connection.customerId,
        query: query
      });

      // Format audiences
      const audiences = response.map(row => ({
        id: row.user_list.id,
        name: row.user_list.name,
        description: row.user_list.description,
        type: this.mapGoogleListType(row.user_list.type),
        status: row.user_list.membership_status,
        size: Math.max(row.user_list.size_for_display || 0, row.user_list.size_for_search || 0),
        retentionDays: row.user_list.membership_life_span,
        createdAt: row.user_list.creation_date_time
      }));

      // Paginate results
      const startIndex = (page - 1) * limit;
      const paginatedAudiences = audiences.slice(startIndex, startIndex + limit);

      const result = {
        audiences: paginatedAudiences,
        pagination: {
          page,
          limit,
          total: audiences.length,
          pages: Math.ceil(audiences.length / limit)
        }
      };

      // Cache results
      await redis.setex(cacheKey, config.cache.ttl.accountList, JSON.stringify(result));

      return result;

    } catch (error) {
      logger.error('Failed to get audiences', error);
      throw this.handleGoogleAdsError(error);
    }
  }

  /**
   * Get audience by ID
   * @param {String} audienceId - Audience ID
   * @param {String} organizationId - Organization ID
   * @returns {Object} Audience details
   */
  async getAudienceById(audienceId, organizationId) {
    try {
      // Get authenticated client
      const { client, connection } = await this.getAuthenticatedClient(organizationId);

      const query = `
        SELECT 
          user_list.id,
          user_list.name,
          user_list.description,
          user_list.membership_status,
          user_list.membership_life_span,
          user_list.size_for_display,
          user_list.size_for_search,
          user_list.type,
          user_list.creation_date_time,
          user_list.crm_based_user_list.upload_key_type,
          user_list.crm_based_user_list.data_source_type
        FROM user_list
        WHERE user_list.id = ${audienceId}
      `;

      const response = await client.query({
        customer_id: connection.customerId,
        query: query
      });

      if (!response || response.length === 0) {
        return null;
      }

      const row = response[0];
      return {
        id: row.user_list.id,
        name: row.user_list.name,
        description: row.user_list.description,
        type: this.mapGoogleListType(row.user_list.type),
        status: row.user_list.membership_status,
        sizeEstimate: {
          display: row.user_list.size_for_display || 0,
          search: row.user_list.size_for_search || 0,
          total: Math.max(row.user_list.size_for_display || 0, row.user_list.size_for_search || 0)
        },
        retentionDays: row.user_list.membership_life_span,
        uploadKeyType: row.user_list.crm_based_user_list?.upload_key_type,
        dataSourceType: row.user_list.crm_based_user_list?.data_source_type,
        createdAt: row.user_list.creation_date_time,
        lastUpdated: new Date()
      };

    } catch (error) {
      logger.error('Failed to get audience by ID', error);
      throw this.handleGoogleAdsError(error);
    }
  }

  /**
   * Get audience size estimate
   * @param {String} audienceId - Audience ID
   * @param {String} organizationId - Organization ID
   * @returns {Object} Size estimate
   */
  async getAudienceEstimate(audienceId, organizationId) {
    try {
      const audience = await this.getAudienceById(audienceId, organizationId);
      
      if (!audience) {
        throw new UserFriendlyError(
          'Audience not found',
          'AUDIENCE_NOT_FOUND'
        );
      }

      // For customer match lists, Google provides size estimates after processing
      return {
        audienceId,
        minSize: audience.sizeEstimate.total * 0.8, // Conservative estimate
        maxSize: audience.sizeEstimate.total * 1.2, // Optimistic estimate
        status: audience.sizeEstimate.total > 0 ? 'READY' : 'PROCESSING',
        lastUpdated: audience.lastUpdated,
        message: audience.sizeEstimate.total === 0 
          ? 'Audience is still processing. Estimates will be available within 24 hours.'
          : null
      };

    } catch (error) {
      logger.error('Failed to get audience estimate', error);
      throw this.handleGoogleAdsError(error);
    }
  }

  /**
   * Update audience by adding or removing customers
   * @param {String} audienceId - Audience ID
   * @param {Object} updates - Customers to add/remove
   * @param {String} organizationId - Organization ID
   * @param {String} userId - User making the update
   * @returns {Object} Update results
   */
  async updateAudience(audienceId, updates, organizationId, userId) {
    try {
      // Get authenticated client
      const { client, connection } = await this.getAuthenticatedClient(organizationId);

      let added = 0;
      let removed = 0;

      // Add customers
      if (updates.add_customers?.length > 0) {
        const customersToAdd = await Customer.find({
          _id: { $in: updates.add_customers },
          _organization: organizationId,
          'marketingConsent.ads': true
        }).select('email phone firstName lastName country zipCode');

        if (customersToAdd.length > 0) {
          const hashedCustomers = await this.hashCustomerData(customersToAdd);
          const userListResourceName = `customers/${connection.customerId}/userLists/${audienceId}`;
          
          const uploadResult = await this.uploadCustomersToList(
            client,
            connection.customerId,
            userListResourceName,
            hashedCustomers,
            'ADD'
          );
          
          added = uploadResult.uploadedCount;
        }
      }

      // Remove customers
      if (updates.remove_customers?.length > 0) {
        const customersToRemove = await Customer.find({
          _id: { $in: updates.remove_customers },
          _organization: organizationId
        }).select('email phone firstName lastName');

        if (customersToRemove.length > 0) {
          const hashedCustomers = await this.hashCustomerData(customersToRemove);
          const userListResourceName = `customers/${connection.customerId}/userLists/${audienceId}`;
          
          const uploadResult = await this.uploadCustomersToList(
            client,
            connection.customerId,
            userListResourceName,
            hashedCustomers,
            'REMOVE'
          );
          
          removed = uploadResult.uploadedCount;
        }
      }

      // Log update
      await AuditLog.create({
        _organization: organizationId,
        _user: userId,
        action: 'google_audience_updated',
        resource: 'GoogleAudience',
        resourceId: audienceId,
        metadata: {
          added,
          removed
        }
      });

      // Clear cache
      await redis.del(`google_audiences:${organizationId}:*`);

      return {
        success: true,
        added,
        removed,
        newSize: 'Processing' // Size will be updated by Google within 24 hours
      };

    } catch (error) {
      logger.error('Failed to update audience', error);
      throw this.handleGoogleAdsError(error);
    }
  }

  /**
   * Delete audience
   * @param {String} audienceId - Audience ID
   * @param {String} organizationId - Organization ID
   * @param {String} userId - User deleting the audience
   */
  async deleteAudience(audienceId, organizationId, userId) {
    try {
      // Get authenticated client
      const { client, connection } = await this.getAuthenticatedClient(organizationId);

      // Close the user list (Google doesn't allow deletion, only closing)
      const operation = {
        update: {
          resource_name: `customers/${connection.customerId}/userLists/${audienceId}`,
          membership_status: 'CLOSED'
        },
        update_mask: 'membership_status'
      };

      await client.userLists.mutate({
        customer_id: connection.customerId,
        operations: [operation]
      });

      // Log deletion
      await AuditLog.create({
        _organization: organizationId,
        _user: userId,
        action: 'google_audience_deleted',
        resource: 'GoogleAudience',
        resourceId: audienceId
      });

      // Clear cache
      await redis.del(`google_audiences:${organizationId}:*`);

      logger.info('Google audience closed', {
        organizationId,
        audienceId
      });

    } catch (error) {
      logger.error('Failed to delete audience', error);
      throw this.handleGoogleAdsError(error);
    }
  }

  /**
   * Create audience from CSV file
   * @param {String} filePath - Path to CSV file
   * @param {Object} audienceConfig - Audience configuration
   * @param {String} organizationId - Organization ID
   * @param {String} userId - User creating the audience
   * @returns {Object} Created audience details
   */
  async createAudienceFromCSV(filePath, audienceConfig, organizationId, userId) {
    try {
      // Read and parse CSV file
      const fileContent = await fs.readFile(filePath, 'utf8');
      const parseResult = Papa.parse(fileContent, {
        header: true,
        dynamicTyping: true,
        skipEmptyLines: true,
        transformHeader: (header) => header.trim().toLowerCase().replace(/\s+/g, '_')
      });

      if (parseResult.errors.length > 0) {
        throw new UserFriendlyError(
          'CSV file contains errors',
          'CSV_PARSE_ERROR',
          { errors: parseResult.errors.slice(0, 5) }
        );
      }

      const records = parseResult.data;
      if (records.length < 100) {
        throw new UserFriendlyError(
          'CSV must contain at least 100 records',
          'INSUFFICIENT_RECORDS',
          { found: records.length, required: 100 }
        );
      }

      // Get authenticated client
      const { client, connection } = await this.getAuthenticatedClient(organizationId);

      // Create user list
      const userListOperation = {
        create: {
          name: audienceConfig.name,
          description: `Uploaded from CSV with ${records.length} records`,
          membership_status: 'OPEN',
          membership_life_span: audienceConfig.retention_days || 30,
          crm_based_user_list: {
            upload_key_type: 'CONTACT_INFO',
            data_source_type: 'FIRST_PARTY'
          }
        }
      };

      const userListResponse = await client.userLists.mutate({
        customer_id: connection.customerId,
        operations: [userListOperation]
      });

      const userListResourceName = userListResponse.results[0].resource_name;
      const userListId = userListResourceName.split('/').pop();

      // Hash and upload records
      const hashedRecords = await this.hashCSVRecords(records, audienceConfig.mapping);
      const uploadResult = await this.uploadCustomersToList(
        client,
        connection.customerId,
        userListResourceName,
        hashedRecords
      );

      // Clean up uploaded file
      await fs.unlink(filePath).catch(err => 
        logger.warn('Failed to delete uploaded file', { filePath, error: err.message })
      );

      // Log creation
      await AuditLog.create({
        _organization: organizationId,
        _user: userId,
        action: 'google_audience_created_from_csv',
        resource: 'GoogleAudience',
        resourceId: userListId,
        metadata: {
          audienceName: audienceConfig.name,
          recordCount: records.length,
          uploadedCount: uploadResult.uploadedCount
        }
      });

      return {
        success: true,
        audienceId: userListId,
        userListId: userListId,
        rowsProcessed: records.length,
        matchedRecords: uploadResult.uploadedCount,
        matchRate: ((uploadResult.uploadedCount / records.length) * 100).toFixed(2) + '%'
      };

    } catch (error) {
      logger.error('Failed to create audience from CSV', error);
      throw this.handleGoogleAdsError(error);
    }
  }

  /**
   * Search for interest targeting options
   * @param {String} query - Search query
   * @param {String} category - Optional category filter
   * @returns {Array} Interest suggestions
   */
  async searchInterests(query, category) {
    try {
      // Check cache
      const cacheKey = `interests:${query}:${category || 'all'}`;
      if (this.interestCache.has(cacheKey)) {
        return this.interestCache.get(cacheKey);
      }

      // In a real implementation, you would use Google's UserInterestService
      // For now, return common interests
      const interests = [
        { id: '80001', name: 'Technology', category: 'Technology & Computing' },
        { id: '80002', name: 'Music Lovers', category: 'Arts & Entertainment' },
        { id: '80003', name: 'Travel Buffs', category: 'Travel' },
        { id: '80004', name: 'Sports Fans', category: 'Sports & Fitness' },
        { id: '80005', name: 'Foodies', category: 'Food & Dining' },
        { id: '80006', name: 'Fashion Enthusiasts', category: 'Beauty & Fashion' },
        { id: '80007', name: 'Gaming Enthusiasts', category: 'Games' },
        { id: '80008', name: 'Business Professionals', category: 'Business' },
        { id: '80009', name: 'Parents', category: 'Family & Relationships' },
        { id: '80010', name: 'Auto Enthusiasts', category: 'Autos & Vehicles' }
      ].filter(interest => 
        interest.name.toLowerCase().includes(query.toLowerCase()) ||
        (category && interest.category.toLowerCase().includes(category.toLowerCase()))
      );

      // Cache results
      this.interestCache.set(cacheKey, interests);

      return interests;

    } catch (error) {
      logger.error('Failed to search interests', error);
      throw this.handleGoogleAdsError(error);
    }
  }

  /**
   * Get targeting suggestions based on seed customers
   * @param {Array} customerIds - Customer IDs to analyze
   * @param {Array} suggestionTypes - Types of suggestions to return
   * @param {String} organizationId - Organization ID
   * @returns {Object} Targeting suggestions
   */
  async getTargetingSuggestions(customerIds, suggestionTypes, organizationId) {
    try {
      // Get customer data for analysis
      const customers = await Customer.find({
        _id: { $in: customerIds },
        _organization: organizationId
      }).select('age gender location interests purchaseHistory');

      if (customers.length === 0) {
        throw new UserFriendlyError(
          'No customers found',
          'CUSTOMERS_NOT_FOUND'
        );
      }

      const suggestions = {};

      // Analyze demographics
      if (suggestionTypes.includes('demographics')) {
        suggestions.demographics = this.analyzeDemographics(customers);
      }

      // Analyze interests (mock data for now)
      if (suggestionTypes.includes('interests')) {
        suggestions.interests = [
          { id: '80002', name: 'Music Lovers', affinity: 0.85 },
          { id: '80003', name: 'Travel Buffs', affinity: 0.72 },
          { id: '80004', name: 'Sports Fans', affinity: 0.65 }
        ];
      }

      // Analyze behaviors (mock data)
      if (suggestionTypes.includes('behaviors')) {
        suggestions.behaviors = [
          { id: 'frequent_travelers', name: 'Frequent Travelers', match: 0.68 },
          { id: 'tech_early_adopters', name: 'Technology Early Adopters', match: 0.75 }
        ];
      }

      // Suggest keywords based on purchase patterns
      if (suggestionTypes.includes('keywords')) {
        suggestions.keywords = [
          { text: 'concert tickets', relevance: 0.9 },
          { text: 'music festival', relevance: 0.85 },
          { text: 'live events', relevance: 0.8 }
        ];
      }

      return suggestions;

    } catch (error) {
      logger.error('Failed to get targeting suggestions', error);
      throw this.handleGoogleAdsError(error);
    }
  }

  // Private helper methods

  /**
   * Get authenticated Google Ads client
   */
  async getAuthenticatedClient(organizationId) {
    const connection = await GoogleConnection.findActiveConnection(organizationId);
    
    if (!connection) {
      throw new UserFriendlyError(
        'No active Google Ads connection found',
        'NO_CONNECTION'
      );
    }

    const client = await googleAuthService.getAuthenticatedClient(organizationId);
    
    return { client, connection };
  }

  /**
   * Hash customer data for privacy
   */
  async hashCustomerData(customers) {
    return customers.map(customer => {
      const hashedData = {
        user_identifiers: []
      };

      // Hash email
      if (customer.email) {
        hashedData.user_identifiers.push({
          hashed_email: this.hashValue(customer.email.toLowerCase().trim())
        });
      }

      // Hash phone
      if (customer.phone) {
        const normalizedPhone = this.normalizePhoneNumber(customer.phone);
        hashedData.user_identifiers.push({
          hashed_phone_number: this.hashValue(normalizedPhone)
        });
      }

      // Hash name
      if (customer.firstName && customer.lastName) {
        hashedData.user_identifiers.push({
          address_info: {
            hashed_first_name: this.hashValue(customer.firstName.toLowerCase().trim()),
            hashed_last_name: this.hashValue(customer.lastName.toLowerCase().trim()),
            country_code: customer.country || 'CO',
            postal_code: customer.zipCode
          }
        });
      }

      return hashedData;
    });
  }

  /**
   * Hash CSV records
   */
  async hashCSVRecords(records, mapping = {}) {
    return records.map(record => {
      const hashedData = {
        user_identifiers: []
      };

      // Email
      const emailField = mapping.email || 'email';
      if (record[emailField]) {
        hashedData.user_identifiers.push({
          hashed_email: this.hashValue(record[emailField].toLowerCase().trim())
        });
      }

      // Phone
      const phoneField = mapping.phone || 'phone';
      if (record[phoneField]) {
        const normalizedPhone = this.normalizePhoneNumber(record[phoneField]);
        hashedData.user_identifiers.push({
          hashed_phone_number: this.hashValue(normalizedPhone)
        });
      }

      // Name and address
      const firstNameField = mapping.first_name || 'first_name';
      const lastNameField = mapping.last_name || 'last_name';
      const countryField = mapping.country || 'country';
      const zipField = mapping.zip_code || 'zip_code';

      if (record[firstNameField] && record[lastNameField]) {
        hashedData.user_identifiers.push({
          address_info: {
            hashed_first_name: this.hashValue(record[firstNameField].toLowerCase().trim()),
            hashed_last_name: this.hashValue(record[lastNameField].toLowerCase().trim()),
            country_code: record[countryField] || 'CO',
            postal_code: record[zipField]
          }
        });
      }

      return hashedData;
    });
  }

  /**
   * Upload customers to user list
   */
  async uploadCustomersToList(client, customerId, userListResourceName, hashedCustomers, operationType = 'ADD') {
    try {
      // Create offline user data job
      const jobOperation = {
        create: {
          type: 'CUSTOMER_MATCH_USER_LIST',
          customer_match_user_list_metadata: {
            user_list: userListResourceName
          }
        }
      };

      const jobResponse = await client.offlineUserDataJobs.create({
        customer_id: customerId,
        job: jobOperation.create
      });

      const jobResourceName = jobResponse.resource_name;

      // Upload in batches
      const batchSize = 10000; // Google's recommended batch size
      let uploadedCount = 0;

      for (let i = 0; i < hashedCustomers.length; i += batchSize) {
        const batch = hashedCustomers.slice(i, i + batchSize);
        
        const operations = batch.map(userData => ({
          [operationType.toLowerCase()]: userData
        }));

        await client.offlineUserDataJobs.addOperations({
          resource_name: jobResourceName,
          operations: operations
        });

        uploadedCount += batch.length;
        
        logger.info(`Uploaded batch ${Math.floor(i / batchSize) + 1}`, {
          uploadedCount,
          totalCount: hashedCustomers.length
        });
      }

      // Run the job
      await client.offlineUserDataJobs.run({
        resource_name: jobResourceName
      });

      return {
        uploadedCount,
        jobId: jobResourceName.split('/').pop()
      };

    } catch (error) {
      logger.error('Failed to upload customers', error);
      throw error;
    }
  }

  /**
   * Hash value using SHA256
   */
  hashValue(value) {
    return crypto
      .createHash('sha256')
      .update(value)
      .digest('hex');
  }

  /**
   * Normalize phone number for hashing
   */
  normalizePhoneNumber(phone) {
    // Remove all non-digits
    let normalized = phone.replace(/\D/g, '');
    
    // Add country code if missing (assuming Colombia)
    if (!normalized.startsWith('57') && normalized.length === 10) {
      normalized = '57' + normalized;
    }
    
    // Add + prefix
    return '+' + normalized;
  }

  /**
   * Map ratio to Google's expansion level
   */
  mapRatioToExpansionLevel(ratio) {
    if (ratio <= 0.01) return 'NARROW';
    if (ratio <= 0.05) return 'DEFAULT';
    return 'BROAD';
  }

  /**
   * Estimate lookalike reach
   */
  estimateLookalikeReach(country, ratio) {
    // Mock estimates based on country population
    const countryPopulations = {
      'CO': 50000000,  // Colombia
      'US': 330000000, // United States
      'BR': 210000000, // Brazil
      'MX': 130000000  // Mexico
    };

    const population = countryPopulations[country] || 50000000;
    const internetPenetration = 0.7; // Assume 70% internet penetration
    const reachablePopulation = population * internetPenetration;
    
    return {
      min: Math.floor(reachablePopulation * ratio * 0.8),
      max: Math.floor(reachablePopulation * ratio * 1.2)
    };
  }

  /**
   * Map Google list type to internal type
   */
  mapGoogleListType(googleType) {
    const typeMap = {
      'CRM_BASED': 'CUSTOMER_MATCH',
      'LOOKALIKE': 'LOOKALIKE',
      'RULE_BASED': 'REMARKETING',
      'LOGICAL': 'CUSTOM'
    };

    return typeMap[googleType] || googleType;
  }

  /**
   * Analyze demographics from customers
   */
  analyzeDemographics(customers) {
    const ageRanges = {
      '18-24': 0,
      '25-34': 0,
      '35-44': 0,
      '45-54': 0,
      '55-64': 0,
      '65+': 0
    };

    const genders = {
      male: 0,
      female: 0,
      other: 0
    };

    customers.forEach(customer => {
      // Age analysis
      if (customer.age) {
        if (customer.age >= 18 && customer.age <= 24) ageRanges['18-24']++;
        else if (customer.age <= 34) ageRanges['25-34']++;
        else if (customer.age <= 44) ageRanges['35-44']++;
        else if (customer.age <= 54) ageRanges['45-54']++;
        else if (customer.age <= 64) ageRanges['55-64']++;
        else ageRanges['65+']++;
      }

      // Gender analysis
      if (customer.gender) {
        genders[customer.gender.toLowerCase()] = (genders[customer.gender.toLowerCase()] || 0) + 1;
      }
    });

    // Convert to percentages
    const total = customers.length;
    
    return {
      ageRanges: Object.entries(ageRanges)
        .filter(([_, count]) => count > 0)
        .map(([range, count]) => ({
          range,
          percentage: ((count / total) * 100).toFixed(1)
        }))
        .sort((a, b) => parseFloat(b.percentage) - parseFloat(a.percentage)),
      
      genders: Object.entries(genders)
        .filter(([_, count]) => count > 0)
        .map(([gender, count]) => ({
          gender,
          percentage: ((count / total) * 100).toFixed(1)
        }))
        .sort((a, b) => parseFloat(b.percentage) - parseFloat(a.percentage))
    };
  }

  /**
   * Handle Google Ads API errors
   */
  handleGoogleAdsError(error) {
    const errorDetails = error.errors?.[0] || error;
    
    const errorMappings = {
      'USER_LIST_TOO_SMALL': 'Audience must contain at least 100 customers',
      'USER_LIST_NAME_ALREADY_USED': 'An audience with this name already exists',
      'INVALID_USER_LIST_ID': 'Invalid audience ID',
      'INSUFFICIENT_PERMISSION': 'You do not have permission to manage audiences',
      'CUSTOMER_NOT_WHITELISTED_FOR_CL': 'Customer Match is not enabled for your account',
      'TOO_MANY_IDENTIFIERS': 'Too many identifiers in a single request. Please reduce batch size.'
    };

    const userMessage = errorMappings[errorDetails.error_code?.error_code] || 
                       'Failed to complete audience operation. Please check your settings.';

    return new UserFriendlyError(userMessage, errorDetails.error_code?.error_code || 'GOOGLE_ADS_ERROR', {
      originalError: errorDetails.message,
      fieldPath: errorDetails.location?.field_path_elements
    });
  }
}

module.exports = new GoogleAudienceService();