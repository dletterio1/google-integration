const GoogleConnection = require('../models/GoogleConnection.model');
const { UserFriendlyError } = require('../utils/errors');
const { ResponseFormatter } = require('../utils/responseFormatter');
const googleAdsConfig = require('../config/google-ads.config');
const logger = require('../utils/logger');

class GoogleAdsAuthMiddleware {
  /**
   * Ensure organization has active Google Ads connection
   */
  static async requireConnection(req, res, next) {
    try {
      const { organizationId } = req.auth;

      // Check for active connection
      const connection = await GoogleConnection.findActiveConnection(organizationId);

      if (!connection) {
        throw new UserFriendlyError(
          'No active Google Ads connection found. Please connect your Google Ads account first.',
          'NO_GOOGLE_CONNECTION'
        );
      }

      // Check if connection is in good standing
      if (connection.status !== 'active') {
        throw new UserFriendlyError(
          `Google Ads connection is ${connection.status}. Please reconnect your account.`,
          'GOOGLE_CONNECTION_INACTIVE',
          { status: connection.status, reason: connection.statusReason }
        );
      }

      // Check if token needs refresh (will be handled by service layer)
      if (connection.needsTokenRefresh) {
        logger.info('Google Ads token needs refresh', {
          organizationId,
          customerId: connection.customerId
        });
      }

      // Attach connection to request for downstream use
      req.googleConnection = connection;
      req.googleCustomerId = connection.customerId;

      next();
    } catch (error) {
      logger.error('Google Ads auth middleware error', error);
      return ResponseFormatter.error(res, error);
    }
  }

  /**
   * Rate limit Google Ads API calls per organization
   */
  static async rateLimitGoogleAPI(req, res, next) {
    try {
      const connection = req.googleConnection;
      
      if (!connection) {
        return next();
      }

      // Check if quota needs reset
      if (connection.needsQuotaReset) {
        connection.dailyApiOperations = 0;
        connection.apiQuotaResetAt = new Date();
        connection.apiQuotaResetAt.setDate(connection.apiQuotaResetAt.getDate() + 1);
        connection.apiQuotaResetAt.setHours(0, 0, 0, 0);
        await connection.save();
      }

      // Get operation cost based on endpoint
      const operationCost = GoogleAdsAuthMiddleware.getOperationCost(req.path, req.method);
      
      // Check against daily limit (basic access)
      const dailyLimit = googleAdsConfig.rateLimits.daily.basic;
      
      if (connection.dailyApiOperations + operationCost > dailyLimit) {
        const resetTime = connection.apiQuotaResetAt.toLocaleString('en-US', {
          timeZone: 'America/Los_Angeles'
        });

        throw new UserFriendlyError(
          `Daily Google Ads API limit reached (${dailyLimit} operations). Limit resets at ${resetTime} PST.`,
          'GOOGLE_QUOTA_EXCEEDED',
          {
            used: connection.dailyApiOperations,
            limit: dailyLimit,
            resetAt: connection.apiQuotaResetAt
          }
        );
      }

      // Attach operation cost for post-processing
      req.googleOperationCost = operationCost;

      next();
    } catch (error) {
      logger.error('Google Ads rate limit error', error);
      return ResponseFormatter.error(res, error);
    }
  }

  /**
   * Track API usage after successful request
   */
  static async trackApiUsage(req, res, next) {
    // This runs after the response is sent
    res.on('finish', async () => {
      try {
        if (req.googleConnection && req.googleOperationCost && res.statusCode < 400) {
          await req.googleConnection.incrementApiOperations(req.googleOperationCost);
          
          logger.info('Google Ads API operation tracked', {
            organizationId: req.auth.organizationId,
            customerId: req.googleCustomerId,
            operation: `${req.method} ${req.path}`,
            cost: req.googleOperationCost,
            totalUsed: req.googleConnection.dailyApiOperations + req.googleOperationCost
          });
        }
      } catch (error) {
        logger.error('Failed to track Google API usage', error);
      }
    });
    
    next();
  }

  /**
   * Validate campaign ownership
   */
  static async validateCampaignOwnership(req, res, next) {
    try {
      const { organizationId } = req.auth;
      const { campaignId } = req.params;

      if (!campaignId) {
        throw new UserFriendlyError(
          'Campaign ID is required',
          'MISSING_CAMPAIGN_ID'
        );
      }

      // Import Campaign model (circular dependency prevention)
      const Campaign = require('../models/Campaign.model');

      const campaign = await Campaign.findOne({
        _id: campaignId,
        _organization: organizationId,
        platform: { $in: ['google', 'multi'] }
      });

      if (!campaign) {
        throw new UserFriendlyError(
          'Campaign not found or you do not have access to it',
          'CAMPAIGN_NOT_FOUND'
        );
      }

      if (!campaign.googleCampaignId) {
        throw new UserFriendlyError(
          'This campaign is not connected to Google Ads',
          'NOT_GOOGLE_CAMPAIGN'
        );
      }

      // Attach campaign to request
      req.campaign = campaign;

      next();
    } catch (error) {
      logger.error('Campaign ownership validation error', error);
      return ResponseFormatter.error(res, error);
    }
  }

  /**
   * Validate audience ownership
   */
  static async validateAudienceOwnership(req, res, next) {
    try {
      const { organizationId } = req.auth;
      const { audienceId } = req.params;

      if (!audienceId) {
        throw new UserFriendlyError(
          'Audience ID is required',
          'MISSING_AUDIENCE_ID'
        );
      }

      // Import GoogleAudience model (to be created)
      // const GoogleAudience = require('../models/GoogleAudience.model');

      // TODO: Implement when GoogleAudience model is created
      // For now, just pass through
      next();
    } catch (error) {
      logger.error('Audience ownership validation error', error);
      return ResponseFormatter.error(res, error);
    }
  }

  /**
   * Helper to determine operation cost based on endpoint
   */
  static getOperationCost(path, method) {
    // Mutations cost more than reads
    if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
      if (path.includes('/campaigns')) return 10;
      if (path.includes('/audiences/customer-match')) return 20;
      if (path.includes('/audiences')) return 10;
      if (path.includes('/assets')) return 5;
      return 10; // Default mutation cost
    }

    // Reads
    if (path.includes('/reports')) return 5;
    if (path.includes('/metrics')) return 2;
    if (path.includes('/estimate')) return 50;
    
    return 1; // Default read cost
  }

  /**
   * Ensure user has necessary permissions for Google Ads operations
   */
  static async requireAdminPermission(req, res, next) {
    try {
      const { role, permissions } = req.auth;

      // Check if user is admin or has specific AdBuilder permissions
      const hasPermission = role === 'admin' || 
                           role === 'owner' ||
                           permissions?.includes('adbuilder.manage');

      if (!hasPermission) {
        throw new UserFriendlyError(
          'You do not have permission to manage Google Ads campaigns',
          'INSUFFICIENT_PERMISSIONS'
        );
      }

      next();
    } catch (error) {
      logger.error('Permission check error', error);
      return ResponseFormatter.error(res, error);
    }
  }
}

module.exports = GoogleAdsAuthMiddleware;