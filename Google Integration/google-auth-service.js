const { OAuth2Client } = require('google-auth-library');
const { GoogleAdsApi } = require('google-ads-api');
const crypto = require('crypto');
const config = require('../../config/google-ads.config');
const GoogleConnection = require('../../models/GoogleConnection.model');
const AuditLog = require('../../models/AuditLog.model');
const redis = require('../../config/redis');
const { UserFriendlyError } = require('../../utils/errors');
const encryptionService = require('../encryption.service');
const logger = require('../../utils/logger');

class GoogleAuthService {
  constructor() {
    this.oauth2Client = new OAuth2Client(
      config.oauth.clientId,
      config.oauth.clientSecret,
      config.oauth.redirectUri
    );
  }

  /**
   * Initiate OAuth flow for Google Ads connection
   * @param {String} organizationId - Organization ID
   * @param {String} userId - User initiating connection
   * @returns {Object} { authUrl, state }
   */
  async initiateOAuthFlow(organizationId, userId) {
    try {
      // Generate secure state token
      const state = await this.generateSecureState(organizationId, userId);
      
      // Build authorization URL
      const authUrl = this.oauth2Client.generateAuthUrl({
        access_type: config.oauth.accessType,
        prompt: config.oauth.prompt,
        scope: config.oauth.scopes,
        state: state,
        include_granted_scopes: true,
        // Add login hint if we have a previous connection
        login_hint: await this.getLoginHint(organizationId)
      });

      logger.info('Google OAuth flow initiated', {
        organizationId,
        userId,
        state: state.substring(0, 8) + '...'
      });

      return { authUrl, state };
    } catch (error) {
      logger.error('Failed to initiate Google OAuth flow', error);
      throw new UserFriendlyError(
        'Failed to start Google Ads connection process',
        'OAUTH_INIT_ERROR'
      );
    }
  }

  /**
   * Handle OAuth callback from Google
   * @param {String} code - Authorization code
   * @param {String} state - State token
   * @returns {Object} GoogleConnection document
   */
  async handleOAuthCallback(code, state) {
    try {
      // Validate state
      const stateData = await this.validateState(state);
      if (!stateData) {
        throw new UserFriendlyError(
          'Invalid or expired authentication state. Please try connecting again.',
          'INVALID_STATE'
        );
      }

      // Exchange code for tokens
      const { tokens } = await this.oauth2Client.getToken(code);
      
      if (!tokens.refresh_token) {
        throw new UserFriendlyError(
          'Failed to obtain refresh token. Please try connecting again and make sure to grant all permissions.',
          'NO_REFRESH_TOKEN'
        );
      }

      // Set credentials for subsequent API calls
      this.oauth2Client.setCredentials(tokens);

      // Get user info
      const userInfo = await this.getUserInfo(tokens.access_token);

      // Initialize Google Ads API client
      const client = this.createGoogleAdsClient(tokens.refresh_token);

      // Discover accessible customer accounts
      const customers = await this.discoverCustomers(client);
      
      if (!customers || customers.length === 0) {
        throw new UserFriendlyError(
          'No Google Ads accounts found. Please ensure you have access to at least one Google Ads account.',
          'NO_ACCOUNTS_FOUND'
        );
      }

      // Select primary customer (first enabled non-test account or first account)
      const primaryCustomer = this.selectPrimaryCustomer(customers);

      // Check for existing connection
      const existingConnection = await GoogleConnection.findOne({
        _organization: stateData.organizationId,
        googleUserId: userInfo.id
      });

      let connection;
      if (existingConnection) {
        // Update existing connection
        connection = await this.updateConnection(existingConnection, {
          accessToken: encryptionService.encrypt(tokens.access_token),
          refreshToken: encryptionService.encrypt(tokens.refresh_token),
          tokenExpiresAt: new Date(tokens.expiry_date || Date.now() + 3600 * 1000),
          customerId: primaryCustomer.customerId,
          customerName: primaryCustomer.descriptiveName,
          currencyCode: primaryCustomer.currencyCode,
          timeZone: primaryCustomer.timeZone,
          accessibleCustomers: customers,
          status: 'active',
          lastSyncAt: new Date(),
          syncFailures: 0,
          _updated_by: stateData.userId
        });
      } else {
        // Create new connection
        connection = await GoogleConnection.create({
          _organization: stateData.organizationId,
          _connected_by: stateData.userId,
          googleUserId: userInfo.id,
          googleUserEmail: userInfo.email,
          managerCustomerId: config.customer.managerAccountId,
          customerId: primaryCustomer.customerId,
          customerName: primaryCustomer.descriptiveName,
          currencyCode: primaryCustomer.currencyCode,
          timeZone: primaryCustomer.timeZone,
          accessToken: encryptionService.encrypt(tokens.access_token),
          refreshToken: encryptionService.encrypt(tokens.refresh_token),
          tokenExpiresAt: new Date(tokens.expiry_date || Date.now() + 3600 * 1000),
          accessibleCustomers: customers,
          permissions: tokens.scope ? tokens.scope.split(' ') : config.oauth.scopes,
          hasAcceptedTos: true,
          tosAcceptedAt: new Date(),
          status: 'active',
          connectedAt: new Date()
        });
      }

      // Log successful connection
      await this.logConnectionEvent(connection, stateData.userId, existingConnection ? 'updated' : 'created');

      // Clean up state from Redis
      await redis.del(`google_oauth_state:${state}`);

      logger.info('Google Ads connection established', {
        organizationId: stateData.organizationId,
        customerId: primaryCustomer.customerId,
        accountCount: customers.length
      });

      return connection;
    } catch (error) {
      logger.error('Google OAuth callback error', error);
      
      // Clean up state on error
      if (state) {
        await redis.del(`google_oauth_state:${state}`);
      }

      // Re-throw UserFriendlyError or create new one
      if (error instanceof UserFriendlyError) {
        throw error;
      }
      
      throw new UserFriendlyError(
        'Failed to complete Google Ads connection. Please try again.',
        'OAUTH_CALLBACK_ERROR',
        { originalError: error.message }
      );
    }
  }

  /**
   * Get connection status for an organization
   * @param {String} organizationId 
   * @returns {Object} Connection status and details
   */
  async getConnectionStatus(organizationId) {
    try {
      const connection = await GoogleConnection.findActiveConnection(organizationId);
      
      if (!connection) {
        return {
          connected: false,
          message: 'No active Google Ads connection found'
        };
      }

      // Check if token needs refresh
      const needsRefresh = connection.needsTokenRefresh;
      
      return {
        connected: true,
        needsRefresh,
        connectionDetails: {
          customerName: connection.customerName,
          customerId: connection.customerId,
          email: connection.googleUserEmail,
          currencyCode: connection.currencyCode,
          timeZone: connection.timeZone,
          accountCount: connection.accessibleCustomers?.length || 1,
          connectedAt: connection.connectedAt,
          lastSyncAt: connection.lastSyncAt,
          dailyApiUsage: connection.dailyApiOperations,
          quotaResetAt: connection.apiQuotaResetAt
        }
      };
    } catch (error) {
      logger.error('Error checking connection status', error);
      throw new UserFriendlyError(
        'Failed to check connection status',
        'STATUS_CHECK_ERROR'
      );
    }
  }

  /**
   * Get accessible Google Ads accounts for an organization
   * @param {String} organizationId 
   * @returns {Array} List of accessible accounts
   */
  async getAccessibleAccounts(organizationId) {
    try {
      const connection = await GoogleConnection.findActiveConnection(organizationId);
      
      if (!connection) {
        throw new UserFriendlyError(
          'No active Google Ads connection found',
          'NO_CONNECTION'
        );
      }

      // Refresh token if needed
      if (connection.needsTokenRefresh) {
        await this.refreshAccessToken(connection);
      }

      // Return cached accounts if recent
      if (connection.lastSyncAt && 
          new Date() - connection.lastSyncAt < config.cache.ttl.accountList * 1000) {
        return connection.accessibleCustomers;
      }

      // Re-fetch accounts from Google
      const client = this.createGoogleAdsClient(
        encryptionService.decrypt(connection.refreshToken)
      );
      const customers = await this.discoverCustomers(client);

      // Update connection with fresh data
      connection.accessibleCustomers = customers;
      connection.lastSyncAt = new Date();
      await connection.save();

      return customers;
    } catch (error) {
      logger.error('Error fetching accessible accounts', error);
      
      if (error instanceof UserFriendlyError) {
        throw error;
      }
      
      throw new UserFriendlyError(
        'Failed to fetch Google Ads accounts',
        'FETCH_ACCOUNTS_ERROR'
      );
    }
  }

  /**
   * Disconnect Google Ads for an organization
   * @param {String} organizationId 
   * @param {String} userId - User performing disconnection
   * @returns {Boolean} Success
   */
  async disconnect(organizationId, userId) {
    try {
      const connection = await GoogleConnection.findActiveConnection(organizationId);
      
      if (!connection) {
        throw new UserFriendlyError(
          'No active Google Ads connection found',
          'NO_CONNECTION'
        );
      }

      // Revoke tokens with Google (best practice)
      try {
        const refreshToken = encryptionService.decrypt(connection.refreshToken);
        await this.oauth2Client.revokeToken(refreshToken);
      } catch (revokeError) {
        // Log but don't fail - token might already be invalid
        logger.warn('Failed to revoke Google token', revokeError);
      }

      // Update connection status
      connection.status = 'revoked';
      connection.statusReason = 'User disconnected';
      connection._updated_by = userId;
      await connection.save();

      // Log disconnection
      await this.logConnectionEvent(connection, userId, 'disconnected');

      logger.info('Google Ads connection disconnected', {
        organizationId,
        customerId: connection.customerId
      });

      return true;
    } catch (error) {
      logger.error('Error disconnecting Google Ads', error);
      
      if (error instanceof UserFriendlyError) {
        throw error;
      }
      
      throw new UserFriendlyError(
        'Failed to disconnect Google Ads',
        'DISCONNECT_ERROR'
      );
    }
  }

  /**
   * Refresh access token for a connection
   * @param {GoogleConnection} connection 
   * @returns {String} New access token
   */
  async refreshAccessToken(connection) {
    try {
      const refreshToken = encryptionService.decrypt(connection.refreshToken);
      
      this.oauth2Client.setCredentials({
        refresh_token: refreshToken
      });

      const { credentials } = await this.oauth2Client.refreshAccessToken();
      
      // Update connection with new token
      connection.accessToken = encryptionService.encrypt(credentials.access_token);
      connection.tokenExpiresAt = new Date(credentials.expiry_date || Date.now() + 3600 * 1000);
      await connection.save();

      logger.info('Google access token refreshed', {
        organizationId: connection._organization,
        customerId: connection.customerId
      });

      return credentials.access_token;
    } catch (error) {
      logger.error('Failed to refresh Google access token', error);
      
      // Mark connection as expired if refresh fails
      connection.status = 'expired';
      connection.statusReason = 'Token refresh failed';
      connection.lastError = {
        message: error.message,
        code: error.code || 'REFRESH_FAILED',
        timestamp: new Date()
      };
      await connection.save();

      throw new UserFriendlyError(
        'Failed to refresh Google Ads connection. Please reconnect your account.',
        'TOKEN_REFRESH_FAILED'
      );
    }
  }

  /**
   * Get authenticated Google Ads client for an organization
   * @param {String} organizationId 
   * @returns {GoogleAdsApi} Authenticated client
   */
  async getAuthenticatedClient(organizationId) {
    const connection = await GoogleConnection.findActiveConnection(organizationId);
    
    if (!connection) {
      throw new UserFriendlyError(
        'No active Google Ads connection found',
        'NO_CONNECTION'
      );
    }

    // Refresh token if needed
    if (connection.needsTokenRefresh) {
      await this.refreshAccessToken(connection);
    }

    const refreshToken = encryptionService.decrypt(connection.refreshToken);
    
    return this.createGoogleAdsClient(refreshToken, connection.customerId);
  }

  // Private helper methods

  /**
   * Generate secure state token for OAuth
   */
  async generateSecureState(organizationId, userId) {
    const stateData = {
      organizationId,
      userId,
      timestamp: Date.now(),
      nonce: crypto.randomBytes(16).toString('hex')
    };

    const state = crypto
      .createHash('sha256')
      .update(JSON.stringify(stateData))
      .digest('hex');

    // Store in Redis with 1 hour TTL
    await redis.setex(
      `google_oauth_state:${state}`,
      3600,
      JSON.stringify(stateData)
    );

    return state;
  }

  /**
   * Validate OAuth state token
   */
  async validateState(state) {
    const key = `google_oauth_state:${state}`;
    const stateData = await redis.get(key);

    if (!stateData) {
      return null;
    }

    const parsed = JSON.parse(stateData);

    // Check if state is not too old (1 hour)
    if (Date.now() - parsed.timestamp > 3600000) {
      await redis.del(key);
      return null;
    }

    return parsed;
  }

  /**
   * Get user info from Google
   */
  async getUserInfo(accessToken) {
    const response = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    });

    if (!response.ok) {
      throw new Error('Failed to fetch user info from Google');
    }

    return response.json();
  }

  /**
   * Create Google Ads API client
   */
  createGoogleAdsClient(refreshToken, customerId = null) {
    const clientConfig = {
      client_id: config.oauth.clientId,
      client_secret: config.oauth.clientSecret,
      developer_token: config.developer.token,
      refresh_token: refreshToken
    };

    if (config.customer.loginCustomerId) {
      clientConfig.login_customer_id = config.customer.loginCustomerId;
    }

    if (customerId) {
      clientConfig.customer_id = customerId;
    }

    return new GoogleAdsApi(clientConfig);
  }

  /**
   * Discover accessible Google Ads accounts
   */
  async discoverCustomers(client) {
    try {
      // Get list of accessible customers
      const customerService = client.CustomerService();
      const response = await customerService.listAccessibleCustomers();
      
      if (!response.resource_names || response.resource_names.length === 0) {
        return [];
      }

      // Extract customer IDs from resource names
      const customerIds = response.resource_names.map(
        resourceName => resourceName.split('/')[1]
      );

      // Fetch details for each customer
      const customers = [];
      const errors = [];

      for (const customerId of customerIds) {
        try {
          const customer = await this.fetchCustomerDetails(client, customerId);
          if (customer) {
            customers.push(customer);
          }
        } catch (error) {
          errors.push({ customerId, error: error.message });
          logger.warn(`Failed to fetch customer ${customerId}:`, error.message);
        }
      }

      // Log any errors for debugging
      if (errors.length > 0) {
        logger.warn('Some customers could not be fetched', { errors });
      }

      return customers;
    } catch (error) {
      logger.error('Failed to discover customers', error);
      throw new Error('Failed to discover Google Ads accounts');
    }
  }

  /**
   * Fetch details for a specific customer
   */
  async fetchCustomerDetails(client, customerId) {
    try {
      const customer = client.Customer({
        customer_id: customerId,
        refresh_token: client.config.refresh_token,
        login_customer_id: client.config.login_customer_id
      });

      const query = `
        SELECT 
          customer.id,
          customer.descriptive_name,
          customer.currency_code,
          customer.time_zone,
          customer.test_account,
          customer.status,
          customer.manager,
          customer.can_manage_clients
        FROM customer
        LIMIT 1
      `;

      const [result] = await customer.query(query);
      
      if (!result || !result.customer) {
        return null;
      }

      const { customer: customerData } = result;

      // Skip suspended accounts unless in development
      if (customerData.status === 'SUSPENDED' && process.env.NODE_ENV !== 'development') {
        return null;
      }

      return {
        customerId: customerData.id,
        descriptiveName: customerData.descriptive_name || `Customer ${customerData.id}`,
        currencyCode: customerData.currency_code,
        timeZone: customerData.time_zone,
        isTestAccount: customerData.test_account || false,
        isManager: customerData.manager || false,
        canManageCampaigns: customerData.status === 'ENABLED',
        accountStatus: customerData.status
      };
    } catch (error) {
      // Don't throw, just return null for inaccessible customers
      return null;
    }
  }

  /**
   * Select primary customer from list
   */
  selectPrimaryCustomer(customers) {
    // Priority order:
    // 1. First enabled non-test, non-manager account
    // 2. First enabled account (even if test)
    // 3. First account regardless of status

    const idealCustomer = customers.find(
      c => c.accountStatus === 'ENABLED' && !c.isTestAccount && !c.isManager
    );
    
    if (idealCustomer) return idealCustomer;

    const enabledCustomer = customers.find(
      c => c.accountStatus === 'ENABLED' && !c.isManager
    );
    
    if (enabledCustomer) return enabledCustomer;

    // Return first non-manager account or first account
    return customers.find(c => !c.isManager) || customers[0];
  }

  /**
   * Get login hint from previous connection
   */
  async getLoginHint(organizationId) {
    const previousConnection = await GoogleConnection.findOne({
      _organization: organizationId
    }).sort({ createdAt: -1 });

    return previousConnection?.googleUserEmail || null;
  }

  /**
   * Update existing connection
   */
  async updateConnection(connection, updates) {
    Object.assign(connection, updates);
    return connection.save();
  }

  /**
   * Log connection event to audit trail
   */
  async logConnectionEvent(connection, userId, action) {
    await AuditLog.create({
      _organization: connection._organization,
      _user: userId,
      action: `google_ads_connection_${action}`,
      resource: 'GoogleConnection',
      resourceId: connection._id,
      metadata: {
        customerId: connection.customerId,
        customerCount: connection.accessibleCustomers?.length || 1,
        email: connection.googleUserEmail
      }
    });
  }
}

module.exports = new GoogleAuthService();