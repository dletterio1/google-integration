const googleCampaignService = require('../../../services/google-ads/google-campaign.service');
const campaignService = require('../../../services/campaign.service');
const { ResponseFormatter } = require('../../../utils/responseFormatter');
const { UserFriendlyError } = require('../../../utils/errors');
const logger = require('../../../utils/logger');

class GoogleCampaignController {
  /**
   * Create a Display campaign
   * @route POST /api/v1/adbuilder/google/campaigns/display
   */
  async createDisplayCampaign(req, res) {
    try {
      const { organizationId, userId } = req.auth;
      const campaignData = req.body;

      // Ensure Google connection exists
      if (!req.googleConnection) {
        throw new UserFriendlyError(
          'Google Ads connection required',
          'NO_GOOGLE_CONNECTION'
        );
      }

      // Add organization and user context
      campaignData._organization = organizationId;
      campaignData._created_by = userId;

      // Create campaign
      const result = await googleCampaignService.createDisplayCampaign(
        campaignData,
        organizationId,
        userId
      );

      logger.info('Display campaign created via API', {
        organizationId,
        campaignId: result.campaign._id,
        googleCampaignId: result.googleCampaignId
      });

      return ResponseFormatter.success(res, {
        campaign: result.campaign,
        googleCampaignId: result.googleCampaignId,
        googleAdGroupId: result.googleAdGroupId
      }, 'Display campaign created successfully');
    } catch (error) {
      logger.error('Failed to create Display campaign', error);
      return ResponseFormatter.error(res, error);
    }
  }

  /**
   * Create a YouTube campaign
   * @route POST /api/v1/adbuilder/google/campaigns/youtube
   */
  async createYouTubeCampaign(req, res) {
    try {
      const { organizationId, userId } = req.auth;
      const campaignData = req.body;

      // Ensure Google connection exists
      if (!req.googleConnection) {
        throw new UserFriendlyError(
          'Google Ads connection required',
          'NO_GOOGLE_CONNECTION'
        );
      }

      // Add organization and user context
      campaignData._organization = organizationId;
      campaignData._created_by = userId;

      // Create campaign
      const result = await googleCampaignService.createYouTubeCampaign(
        campaignData,
        organizationId,
        userId
      );

      logger.info('YouTube campaign created via API', {
        organizationId,
        campaignId: result.campaign._id,
        googleCampaignId: result.googleCampaignId
      });

      return ResponseFormatter.success(res, {
        campaign: result.campaign,
        googleCampaignId: result.googleCampaignId,
        googleAdGroupId: result.googleAdGroupId
      }, 'YouTube campaign created successfully');
    } catch (error) {
      logger.error('Failed to create YouTube campaign', error);
      return ResponseFormatter.error(res, error);
    }
  }

  /**
   * Get campaign details with Google-specific data
   * @route GET /api/v1/adbuilder/google/campaigns/:campaignId
   */
  async getCampaignDetails(req, res) {
    try {
      const { organizationId } = req.auth;
      const { campaignId } = req.params;

      // Get campaign with Google data
      const campaign = await campaignService.getCampaignById(
        campaignId,
        organizationId
      );

      if (!campaign) {
        throw new UserFriendlyError(
          'Campaign not found',
          'CAMPAIGN_NOT_FOUND'
        );
      }

      if (!campaign.googleCampaignId) {
        throw new UserFriendlyError(
          'Not a Google Ads campaign',
          'NOT_GOOGLE_CAMPAIGN'
        );
      }

      // Get ad groups for this campaign
      const GoogleAdGroup = require('../../../models/GoogleAdGroup.model');
      const adGroups = await GoogleAdGroup.findByCampaign(campaignId, organizationId);

      return ResponseFormatter.success(res, {
        campaign,
        adGroups,
        platform: 'google'
      }, 'Campaign details retrieved successfully');
    } catch (error) {
      logger.error('Failed to get campaign details', error);
      return ResponseFormatter.error(res, error);
    }
  }

  /**
   * Update campaign
   * @route PUT /api/v1/adbuilder/google/campaigns/:campaignId
   */
  async updateCampaign(req, res) {
    try {
      const { organizationId, userId } = req.auth;
      const { campaignId } = req.params;
      const updates = req.body;

      // For now, we support budget updates
      if (updates.budget) {
        const result = await googleCampaignService.updateCampaignBudget(
          campaignId,
          updates.budget,
          organizationId,
          userId
        );

        return ResponseFormatter.success(res, {
          campaign: result.campaign
        }, 'Campaign updated successfully');
      }

      throw new UserFriendlyError(
        'Only budget updates are currently supported',
        'UNSUPPORTED_UPDATE'
      );
    } catch (error) {
      logger.error('Failed to update campaign', error);
      return ResponseFormatter.error(res, error);
    }
  }

  /**
   * Update campaign status (pause/resume)
   * @route PATCH /api/v1/adbuilder/google/campaigns/:campaignId/status
   */
  async updateCampaignStatus(req, res) {
    try {
      const { organizationId, userId } = req.auth;
      const { campaignId } = req.params;
      const { status } = req.body;

      const result = await googleCampaignService.updateCampaignStatus(
        campaignId,
        status,
        organizationId,
        userId
      );

      logger.info('Campaign status updated', {
        campaignId,
        newStatus: status,
        googleCampaignId: result.campaign.googleCampaignId
      });

      return ResponseFormatter.success(res, {
        campaign: result.campaign,
        status: result.campaign.status
      }, result.message);
    } catch (error) {
      logger.error('Failed to update campaign status', error);
      return ResponseFormatter.error(res, error);
    }
  }

  /**
   * Sync campaign metrics from Google Ads
   * @route POST /api/v1/adbuilder/google/campaigns/:campaignId/sync
   */
  async syncMetrics(req, res) {
    try {
      const { organizationId } = req.auth;
      const { campaignId } = req.params;
      const { dateRange } = req.body;

      const result = await googleCampaignService.syncCampaignMetrics(
        campaignId,
        organizationId,
        dateRange
      );

      logger.info('Campaign metrics synced', {
        campaignId,
        impressions: result.metrics.impressions,
        clicks: result.metrics.clicks,
        spend: result.metrics.spend
      });

      return ResponseFormatter.success(res, {
        metrics: result.metrics,
        lastSyncedAt: result.metrics.lastSyncedAt
      }, 'Campaign metrics synced successfully');
    } catch (error) {
      logger.error('Failed to sync campaign metrics', error);
      return ResponseFormatter.error(res, error);
    }
  }

  /**
   * Get campaign performance report
   * @route GET /api/v1/adbuilder/google/campaigns/:campaignId/performance
   */
  async getPerformanceReport(req, res) {
    try {
      const { organizationId } = req.auth;
      const { campaignId } = req.params;
      const { startDate, endDate, groupBy } = req.query;

      // Get campaign
      const campaign = await campaignService.getCampaignById(
        campaignId,
        organizationId
      );

      if (!campaign || !campaign.googleCampaignId) {
        throw new UserFriendlyError(
          'Google campaign not found',
          'CAMPAIGN_NOT_FOUND'
        );
      }

      // For now, return current metrics
      // TODO: Implement detailed performance reporting
      const performance = {
        summary: campaign.metrics,
        attribution: campaign.ticketAttribution,
        roi: campaign.ticketAttribution?.roi || 0,
        roas: campaign.ticketAttribution?.roas || 0,
        platform: 'google',
        campaignType: campaign.googleConfig?.campaignType
      };

      return ResponseFormatter.success(res, {
        performance,
        campaign: {
          id: campaign._id,
          name: campaign.name,
          status: campaign.status
        }
      }, 'Performance report retrieved successfully');
    } catch (error) {
      logger.error('Failed to get performance report', error);
      return ResponseFormatter.error(res, error);
    }
  }

  /**
   * Bulk sync metrics for all Google campaigns
   * @route POST /api/v1/adbuilder/google/campaigns/sync-all
   */
  async bulkSyncMetrics(req, res) {
    try {
      const { organizationId } = req.auth;
      const { campaignIds, dateRange } = req.body;

      const results = {
        successful: [],
        failed: []
      };

      // Get campaigns to sync
      const campaigns = await campaignService.getCampaigns(
        {
          platform: { $in: ['google', 'multi'] },
          ...(campaignIds && { _id: { $in: campaignIds } })
        },
        {},
        organizationId
      );

      // Sync each campaign
      for (const campaign of campaigns.campaigns) {
        if (campaign.googleCampaignId) {
          try {
            await googleCampaignService.syncCampaignMetrics(
              campaign._id,
              organizationId,
              dateRange
            );
            results.successful.push(campaign._id);
          } catch (error) {
            logger.error(`Failed to sync campaign ${campaign._id}`, error);
            results.failed.push({
              campaignId: campaign._id,
              error: error.message
            });
          }
        }
      }

      return ResponseFormatter.success(res, {
        synced: results.successful.length,
        failed: results.failed.length,
        results
      }, 'Bulk sync completed');
    } catch (error) {
      logger.error('Failed to bulk sync campaigns', error);
      return ResponseFormatter.error(res, error);
    }
  }

  /**
   * Get available locations for targeting
   * @route GET /api/v1/adbuilder/google/targeting/locations
   */
  async getAvailableLocations(req, res) {
    try {
      const { query, country } = req.query;

      if (!query) {
        throw new UserFriendlyError(
          'Search query is required',
          'MISSING_QUERY'
        );
      }

      // TODO: Implement location search via Google Ads API
      // For now, return common locations
      const locations = [
        { key: '2170', name: 'Colombia', type: 'country' },
        { key: '1003659', name: 'Bogotá', type: 'city', country: 'Colombia' },
        { key: '1003662', name: 'Medellín', type: 'city', country: 'Colombia' },
        { key: '1003663', name: 'Cali', type: 'city', country: 'Colombia' },
        { key: '2840', name: 'United States', type: 'country' },
        { key: '1014221', name: 'New York', type: 'city', country: 'United States' },
        { key: '1014044', name: 'Los Angeles', type: 'city', country: 'United States' }
      ].filter(loc => 
        loc.name.toLowerCase().includes(query.toLowerCase()) ||
        (country && loc.country?.toLowerCase() === country.toLowerCase())
      );

      return ResponseFormatter.success(res, {
        locations,
        count: locations.length
      }, 'Locations retrieved successfully');
    } catch (error) {
      logger.error('Failed to get locations', error);
      return ResponseFormatter.error(res, error);
    }
  }

  /**
   * Get campaign suggestions based on event
   * @route GET /api/v1/adbuilder/google/campaigns/suggestions
   */
  async getCampaignSuggestions(req, res) {
    try {
      const { eventId, campaignType } = req.query;
      const { organizationId } = req.auth;

      // Get event details
      const Event = require('../../../models/Event.model');
      const event = await Event.findOne({
        _id: eventId,
        _organization: organizationId
      });

      if (!event) {
        throw new UserFriendlyError(
          'Event not found',
          'EVENT_NOT_FOUND'
        );
      }

      // Generate suggestions based on event
      const suggestions = {
        display: {
          name: `${event.name} - Display Campaign`,
          budget: {
            amount: 500000, // 500K COP
            type: 'daily'
          },
          schedule: {
            startDate: new Date(),
            endDate: event.date
          },
          biddingStrategy: {
            type: 'MAXIMIZE_CLICKS'
          },
          audience: {
            age_min: 18,
            age_max: 65,
            locations: [{
              key: '1003662',
              name: 'Medellín',
              type: 'city'
            }]
          }
        },
        youtube: {
          name: `${event.name} - YouTube Campaign`,
          budget: {
            amount: 750000, // 750K COP
            type: 'daily'
          },
          schedule: {
            startDate: new Date(),
            endDate: event.date
          },
          biddingStrategy: {
            type: 'TARGET_CPA',
            targetCpa: 5000 // 5K COP per conversion
          },
          videoAdFormat: 'in_stream',
          brandSafety: 'STANDARD_INVENTORY'
        }
      };

      const suggestion = campaignType ? suggestions[campaignType] : suggestions;

      return ResponseFormatter.success(res, {
        suggestion,
        event: {
          id: event._id,
          name: event.name,
          date: event.date
        }
      }, 'Campaign suggestions generated successfully');
    } catch (error) {
      logger.error('Failed to get campaign suggestions', error);
      return ResponseFormatter.error(res, error);
    }
  }
}

module.exports = new GoogleCampaignController();