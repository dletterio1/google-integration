const googleAudienceService = require('../../../services/google-ads/google-audience.service');
const { ResponseFormatter } = require('../../../utils/responseFormatter');
const { UserFriendlyError } = require('../../../utils/errors');
const logger = require('../../../utils/logger');

class GoogleAudienceController {
  /**
   * Create customer match audience (similar to Meta Custom Audiences)
   * @route POST /api/v1/adbuilder/google/audiences/customer-match
   */
  async createCustomerMatch(req, res) {
    try {
      const { organizationId, userId } = req.auth;
      const audienceData = req.body;

      // Ensure Google connection exists
      if (!req.googleConnection) {
        throw new UserFriendlyError(
          'Google Ads connection required',
          'NO_GOOGLE_CONNECTION'
        );
      }

      // Create customer match audience
      const result = await googleAudienceService.createCustomerMatchAudience(
        audienceData,
        organizationId,
        userId
      );

      logger.info('Google customer match audience created', {
        organizationId,
        audienceId: result.audienceId,
        customerCount: audienceData.customer_ids?.length || 0
      });

      return ResponseFormatter.success(res, {
        audienceId: result.audienceId,
        googleUserListId: result.userListId,
        estimatedSize: result.estimatedSize,
        matchRate: result.matchRate
      }, 'Customer match audience created successfully');
    } catch (error) {
      logger.error('Failed to create customer match audience', error);
      return ResponseFormatter.error(res, error);
    }
  }

  /**
   * Create lookalike audience (similar audiences in Google)
   * @route POST /api/v1/adbuilder/google/audiences/lookalike
   */
  async createLookalike(req, res) {
    try {
      const { organizationId, userId } = req.auth;
      const { source_audience_id, lookalike_spec } = req.body;

      // Ensure Google connection exists
      if (!req.googleConnection) {
        throw new UserFriendlyError(
          'Google Ads connection required',
          'NO_GOOGLE_CONNECTION'
        );
      }

      // Create lookalike audience
      const result = await googleAudienceService.createLookalikeAudience(
        source_audience_id,
        lookalike_spec,
        organizationId,
        userId
      );

      logger.info('Google lookalike audience created', {
        organizationId,
        audienceId: result.audienceId,
        sourceAudienceId: source_audience_id
      });

      return ResponseFormatter.success(res, {
        audienceId: result.audienceId,
        googleUserListId: result.userListId,
        estimatedReach: result.estimatedReach,
        country: lookalike_spec.country
      }, 'Lookalike audience created successfully');
    } catch (error) {
      logger.error('Failed to create lookalike audience', error);
      return ResponseFormatter.error(res, error);
    }
  }

  /**
   * Get audience list
   * @route GET /api/v1/adbuilder/google/audiences
   */
  async getAudiences(req, res) {
    try {
      const { organizationId } = req.auth;
      const { page = 1, limit = 20, type } = req.query;

      const result = await googleAudienceService.getAudiences(
        organizationId,
        { page, limit, type }
      );

      return ResponseFormatter.success(res, {
        audiences: result.audiences,
        pagination: result.pagination
      }, 'Audiences retrieved successfully');
    } catch (error) {
      logger.error('Failed to get audiences', error);
      return ResponseFormatter.error(res, error);
    }
  }

  /**
   * Get audience details with size estimate
   * @route GET /api/v1/adbuilder/google/audiences/:audienceId
   */
  async getAudienceDetails(req, res) {
    try {
      const { organizationId } = req.auth;
      const { audienceId } = req.params;

      const audience = await googleAudienceService.getAudienceById(
        audienceId,
        organizationId
      );

      if (!audience) {
        throw new UserFriendlyError(
          'Audience not found',
          'AUDIENCE_NOT_FOUND'
        );
      }

      return ResponseFormatter.success(res, {
        audience,
        sizeEstimate: audience.sizeEstimate,
        lastUpdated: audience.lastUpdated
      }, 'Audience details retrieved successfully');
    } catch (error) {
      logger.error('Failed to get audience details', error);
      return ResponseFormatter.error(res, error);
    }
  }

  /**
   * Get audience size estimate
   * @route GET /api/v1/adbuilder/google/audiences/:audienceId/estimate
   */
  async getAudienceEstimate(req, res) {
    try {
      const { organizationId } = req.auth;
      const { audienceId } = req.params;

      const estimate = await googleAudienceService.getAudienceEstimate(
        audienceId,
        organizationId
      );

      return ResponseFormatter.success(res, {
        audienceId,
        estimate: {
          minSize: estimate.minSize,
          maxSize: estimate.maxSize,
          status: estimate.status,
          lastUpdated: estimate.lastUpdated
        }
      }, 'Audience estimate retrieved successfully');
    } catch (error) {
      logger.error('Failed to get audience estimate', error);
      return ResponseFormatter.error(res, error);
    }
  }

  /**
   * Update audience (add/remove customers)
   * @route PUT /api/v1/adbuilder/google/audiences/:audienceId
   */
  async updateAudience(req, res) {
    try {
      const { organizationId, userId } = req.auth;
      const { audienceId } = req.params;
      const { add_customers, remove_customers } = req.body;

      if (!add_customers?.length && !remove_customers?.length) {
        throw new UserFriendlyError(
          'No customers to add or remove',
          'NO_UPDATE_DATA'
        );
      }

      const result = await googleAudienceService.updateAudience(
        audienceId,
        { add_customers, remove_customers },
        organizationId,
        userId
      );

      logger.info('Google audience updated', {
        organizationId,
        audienceId,
        added: add_customers?.length || 0,
        removed: remove_customers?.length || 0
      });

      return ResponseFormatter.success(res, {
        audienceId,
        added: result.added,
        removed: result.removed,
        newSize: result.newSize
      }, 'Audience updated successfully');
    } catch (error) {
      logger.error('Failed to update audience', error);
      return ResponseFormatter.error(res, error);
    }
  }

  /**
   * Delete audience
   * @route DELETE /api/v1/adbuilder/google/audiences/:audienceId
   */
  async deleteAudience(req, res) {
    try {
      const { organizationId, userId } = req.auth;
      const { audienceId } = req.params;

      await googleAudienceService.deleteAudience(
        audienceId,
        organizationId,
        userId
      );

      logger.info('Google audience deleted', {
        organizationId,
        audienceId
      });

      return ResponseFormatter.success(res, null, 'Audience deleted successfully');
    } catch (error) {
      logger.error('Failed to delete audience', error);
      return ResponseFormatter.error(res, error);
    }
  }

  /**
   * Search for interest targeting options
   * @route GET /api/v1/adbuilder/google/targeting/interests
   */
  async searchInterests(req, res) {
    try {
      const { q, category } = req.query;

      if (!q) {
        throw new UserFriendlyError(
          'Search query is required',
          'MISSING_QUERY'
        );
      }

      const interests = await googleAudienceService.searchInterests(
        q,
        category
      );

      return ResponseFormatter.success(res, {
        interests,
        count: interests.length
      }, 'Interests retrieved successfully');
    } catch (error) {
      logger.error('Failed to search interests', error);
      return ResponseFormatter.error(res, error);
    }
  }

  /**
   * Get demographic targeting options
   * @route GET /api/v1/adbuilder/google/targeting/demographics
   */
  async getDemographicOptions(req, res) {
    try {
      // Return static demographic options
      const demographics = {
        ageRanges: [
          { id: 'AGE_RANGE_18_24', name: '18-24' },
          { id: 'AGE_RANGE_25_34', name: '25-34' },
          { id: 'AGE_RANGE_35_44', name: '35-44' },
          { id: 'AGE_RANGE_45_54', name: '45-54' },
          { id: 'AGE_RANGE_55_64', name: '55-64' },
          { id: 'AGE_RANGE_65_UP', name: '65+' }
        ],
        genders: [
          { id: 'MALE', name: 'Male' },
          { id: 'FEMALE', name: 'Female' },
          { id: 'UNDETERMINED', name: 'All Genders' }
        ],
        parentalStatus: [
          { id: 'PARENT', name: 'Parents' },
          { id: 'NOT_A_PARENT', name: 'Not Parents' }
        ],
        householdIncome: [
          { id: 'INCOME_RANGE_0_50', name: 'Lower 50%' },
          { id: 'INCOME_RANGE_50_75', name: 'Top 50-75%' },
          { id: 'INCOME_RANGE_75_90', name: 'Top 25-10%' },
          { id: 'INCOME_RANGE_90_UP', name: 'Top 10%' }
        ]
      };

      return ResponseFormatter.success(res, demographics, 
        'Demographic options retrieved successfully'
      );
    } catch (error) {
      logger.error('Failed to get demographic options', error);
      return ResponseFormatter.error(res, error);
    }
  }

  /**
   * Create audience from CSV upload
   * @route POST /api/v1/adbuilder/google/audiences/upload
   */
  async createFromUpload(req, res) {
    try {
      const { organizationId, userId } = req.auth;
      const { filename, audience_name, retention_days = 30 } = req.body;

      if (!req.file && !filename) {
        throw new UserFriendlyError(
          'CSV file is required',
          'MISSING_FILE'
        );
      }

      // Process uploaded file
      const filePath = req.file?.path || filename;
      const result = await googleAudienceService.createAudienceFromCSV(
        filePath,
        {
          name: audience_name,
          retention_days
        },
        organizationId,
        userId
      );

      logger.info('Google audience created from CSV', {
        organizationId,
        audienceId: result.audienceId,
        rowsProcessed: result.rowsProcessed,
        matchedRecords: result.matchedRecords
      });

      return ResponseFormatter.success(res, {
        audienceId: result.audienceId,
        googleUserListId: result.userListId,
        rowsProcessed: result.rowsProcessed,
        matchedRecords: result.matchedRecords,
        matchRate: result.matchRate
      }, 'Audience created from CSV successfully');
    } catch (error) {
      logger.error('Failed to create audience from CSV', error);
      return ResponseFormatter.error(res, error);
    }
  }

  /**
   * Get targeting suggestions based on seed customers
   * @route POST /api/v1/adbuilder/google/targeting/suggestions
   */
  async getTargetingSuggestions(req, res) {
    try {
      const { organizationId } = req.auth;
      const { customer_ids, suggestion_types } = req.body;

      if (!customer_ids?.length) {
        throw new UserFriendlyError(
          'Customer IDs are required',
          'MISSING_CUSTOMERS'
        );
      }

      const suggestions = await googleAudienceService.getTargetingSuggestions(
        customer_ids,
        suggestion_types || ['interests', 'demographics'],
        organizationId
      );

      return ResponseFormatter.success(res, {
        suggestions,
        basedOn: customer_ids.length + ' customers'
      }, 'Targeting suggestions generated successfully');
    } catch (error) {
      logger.error('Failed to get targeting suggestions', error);
      return ResponseFormatter.error(res, error);
    }
  }
}

module.exports = new GoogleAudienceController();