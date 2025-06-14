const { GoogleAdsApi } = require('google-ads-api');
const mongoose = require('mongoose');
const Campaign = require('../../models/Campaign.model');
const GoogleConnection = require('../../models/GoogleConnection.model');
const GoogleAdGroup = require('../../models/GoogleAdGroup.model');
const AuditLog = require('../../models/AuditLog.model');
const googleAuthService = require('./google-auth.service');
const encryptionService = require('../encryption.service');
const redis = require('../../config/redis');
const config = require('../../config/google-ads.config');
const { UserFriendlyError } = require('../../utils/errors');
const logger = require('../../utils/logger');

class GoogleCampaignService {
  constructor() {
    this.conversionActionCache = new Map();
    this.geoTargetCache = new Map();
  }

  /**
   * Create a Display campaign in Google Ads
   * @param {Object} campaignData - Campaign configuration
   * @param {String} organizationId - Organization ID
   * @param {String} userId - User creating the campaign
   * @returns {Object} Created campaign details
   */
  async createDisplayCampaign(campaignData, organizationId, userId) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      // Get authenticated client
      const { client, connection } = await this.getAuthenticatedClient(organizationId);
      
      // Validate budget meets minimum requirements
      this.validateBudget(campaignData.budget, connection.currencyCode);

      // Create campaign budget first
      const budgetResourceName = await this.createCampaignBudget(
        client,
        connection.customerId,
        {
          name: `${campaignData.name} - Budget`,
          amount_micros: this.convertToMicros(campaignData.budget.amount, connection.currencyCode),
          delivery_method: campaignData.budget.type === 'daily' ? 'STANDARD' : 'ACCELERATED',
          explicitly_shared: false
        }
      );

      // Create campaign
      const campaignOperation = {
        create: {
          name: campaignData.name,
          status: 'PAUSED', // Always start paused for safety
          advertising_channel_type: 'DISPLAY',
          advertising_channel_sub_type: campaignData.subType || 'DISPLAY_STANDARD',
          
          // Budget reference
          campaign_budget: budgetResourceName,
          
          // Bidding strategy
          ...this.buildBiddingStrategy(campaignData.biddingStrategy),
          
          // Network settings for Display
          network_settings: {
            target_google_search: false,
            target_search_network: false,
            target_content_network: true, // Display Network
            target_partner_search_network: false
          },
          
          // Schedule
          start_date: this.formatDateForGoogle(campaignData.schedule.startDate),
          end_date: this.formatDateForGoogle(campaignData.schedule.endDate),
          
          // Geo targeting type
          geo_target_type_setting: {
            positive_geo_target_type: 'PRESENCE_OR_INTEREST',
            negative_geo_target_type: 'PRESENCE'
          }
        }
      };

      // Execute campaign creation
      const response = await client.campaigns.mutate({
        customer_id: connection.customerId,
        operations: [campaignOperation],
        partial_failure: false
      });

      if (!response.results || response.results.length === 0) {
        throw new Error('No campaign was created');
      }

      const googleCampaignResourceName = response.results[0].resource_name;
      const googleCampaignId = googleCampaignResourceName.split('/').pop();

      // Set geo targeting
      if (campaignData.audience?.locations?.length > 0) {
        await this.setCampaignGeoTargeting(
          client,
          connection.customerId,
          googleCampaignId,
          campaignData.audience.locations
        );
      }

      // Create default ad group
      const adGroupData = {
        name: `${campaignData.name} - Ad Group 1`,
        campaign: googleCampaignResourceName,
        status: 'PAUSED',
        type: 'DISPLAY_STANDARD',
        cpc_bid_micros: campaignData.biddingStrategy.defaultBid 
          ? this.convertToMicros(campaignData.biddingStrategy.defaultBid, connection.currencyCode)
          : 1000000, // Default $1.00
        ad_rotation_mode: 'OPTIMIZE'
      };

      const adGroupResourceName = await this.createAdGroup(
        client,
        connection.customerId,
        adGroupData
      );
      const googleAdGroupId = adGroupResourceName.split('/').pop();

      // Save campaign to database
      const savedCampaign = await Campaign.create({
        _organization: organizationId,
        _event: campaignData._event,
        _metaConnection: null, // This is a Google campaign
        _created_by: userId,
        name: campaignData.name,
        objective: campaignData.objective || 'OUTCOME_TRAFFIC',
        status: 'draft',
        platform: 'google',
        googleCampaignId: googleCampaignId,
        googleCustomerId: connection.customerId,
        googleAdGroupId: googleAdGroupId,
        budget: campaignData.budget,
        schedule: campaignData.schedule,
        audience: campaignData.audience,
        attribution: {
          utm_source: 'google',
          utm_medium: campaignData.attribution?.utm_medium || 'display',
          utm_campaign: campaignData.attribution?.utm_campaign || campaignData.name.toLowerCase().replace(/\s+/g, '-'),
          utm_content: campaignData.attribution?.utm_content,
          utm_term: campaignData.attribution?.utm_term
        },
        googleConfig: {
          campaignType: 'DISPLAY',
          campaignResourceName: googleCampaignResourceName,
          budgetResourceName: budgetResourceName,
          biddingStrategy: campaignData.biddingStrategy,
          networkSettings: {
            targetContentNetwork: true
          }
        }
      });

      // Create GoogleAdGroup record
      await GoogleAdGroup.create({
        _organization: organizationId,
        _campaign: savedCampaign._id,
        _created_by: userId,
        googleAdGroupId: googleAdGroupId,
        googleCampaignId: googleCampaignId,
        googleCustomerId: connection.customerId,
        name: adGroupData.name,
        status: 'PAUSED',
        type: 'DISPLAY_STANDARD',
        bidding: {
          cpc_bid_micros: adGroupData.cpc_bid_micros
        }
      });

      // Set audience targeting if provided
      if (campaignData.audience?.interests?.length > 0 || 
          campaignData.audience?.custom_audiences?.length > 0) {
        await this.setAdGroupTargeting(
          client,
          connection.customerId,
          googleAdGroupId,
          campaignData.audience
        );
      }

      // Log campaign creation
      await AuditLog.create({
        _organization: organizationId,
        _user: userId,
        action: 'google_display_campaign_created',
        resource: 'Campaign',
        resourceId: savedCampaign._id,
        metadata: {
          campaignName: campaignData.name,
          googleCampaignId: googleCampaignId,
          budget: campaignData.budget.amount,
          currency: connection.currencyCode
        }
      });

      await session.commitTransaction();

      // Clear campaign cache
      await redis.del(`campaigns:${organizationId}:*`);

      logger.info('Google Display campaign created successfully', {
        organizationId,
        campaignId: savedCampaign._id,
        googleCampaignId
      });

      return {
        success: true,
        campaign: savedCampaign,
        googleCampaignId,
        googleAdGroupId,
        message: 'Display campaign created successfully'
      };

    } catch (error) {
      await session.abortTransaction();
      logger.error('Failed to create Google Display campaign', error);
      throw this.handleGoogleAdsError(error);
    } finally {
      session.endSession();
    }
  }

  /**
   * Create a YouTube campaign in Google Ads
   * @param {Object} campaignData - Campaign configuration
   * @param {String} organizationId - Organization ID
   * @param {String} userId - User creating the campaign
   * @returns {Object} Created campaign details
   */
  async createYouTubeCampaign(campaignData, organizationId, userId) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      // Get authenticated client
      const { client, connection } = await this.getAuthenticatedClient(organizationId);
      
      // Validate budget
      this.validateBudget(campaignData.budget, connection.currencyCode);

      // Create campaign budget
      const budgetResourceName = await this.createCampaignBudget(
        client,
        connection.customerId,
        {
          name: `${campaignData.name} - Budget`,
          amount_micros: this.convertToMicros(campaignData.budget.amount, connection.currencyCode),
          delivery_method: 'STANDARD'
        }
      );

      // Determine video campaign subtype
      const subType = campaignData.videoGoal || 'VIDEO_ACTION'; // Drive conversions

      // Create campaign
      const campaignOperation = {
        create: {
          name: campaignData.name,
          status: 'PAUSED',
          advertising_channel_type: 'VIDEO',
          advertising_channel_sub_type: subType,
          
          campaign_budget: budgetResourceName,
          
          // Bidding strategy for video
          ...this.buildVideoBiddingStrategy(campaignData.biddingStrategy, subType),
          
          // Video campaign settings
          video_brand_safety_suitability: campaignData.brandSafety || 'EXPANDED_INVENTORY',
          
          // Network settings for YouTube
          network_settings: {
            target_google_search: false,
            target_search_network: false,
            target_content_network: false,
            target_partner_search_network: false,
            target_youtube: true,
            target_google_tv_network: campaignData.includeGoogleTv || false
          },
          
          // Schedule
          start_date: this.formatDateForGoogle(campaignData.schedule.startDate),
          end_date: this.formatDateForGoogle(campaignData.schedule.endDate),
          
          // Geo targeting
          geo_target_type_setting: {
            positive_geo_target_type: 'PRESENCE_OR_INTEREST',
            negative_geo_target_type: 'PRESENCE'
          }
        }
      };

      // Execute campaign creation
      const response = await client.campaigns.mutate({
        customer_id: connection.customerId,
        operations: [campaignOperation],
        partial_failure: false
      });

      const googleCampaignResourceName = response.results[0].resource_name;
      const googleCampaignId = googleCampaignResourceName.split('/').pop();

      // Set geo targeting
      if (campaignData.audience?.locations?.length > 0) {
        await this.setCampaignGeoTargeting(
          client,
          connection.customerId,
          googleCampaignId,
          campaignData.audience.locations
        );
      }

      // Create video ad group
      const adGroupType = this.getVideoAdGroupType(campaignData.videoAdFormat);
      const adGroupData = {
        name: `${campaignData.name} - Video Ad Group`,
        campaign: googleCampaignResourceName,
        status: 'PAUSED',
        type: adGroupType,
        cpv_bid_micros: campaignData.biddingStrategy.targetCpv 
          ? this.convertToMicros(campaignData.biddingStrategy.targetCpv, connection.currencyCode)
          : 100000, // Default $0.10 CPV
        ad_rotation_mode: 'OPTIMIZE'
      };

      const adGroupResourceName = await this.createAdGroup(
        client,
        connection.customerId,
        adGroupData
      );
      const googleAdGroupId = adGroupResourceName.split('/').pop();

      // Save campaign to database
      const savedCampaign = await Campaign.create({
        _organization: organizationId,
        _event: campaignData._event,
        _metaConnection: null,
        _created_by: userId,
        name: campaignData.name,
        objective: campaignData.objective || 'OUTCOME_AWARENESS',
        status: 'draft',
        platform: 'google',
        googleCampaignId: googleCampaignId,
        googleCustomerId: connection.customerId,
        googleAdGroupId: googleAdGroupId,
        budget: campaignData.budget,
        schedule: campaignData.schedule,
        audience: campaignData.audience,
        attribution: {
          utm_source: 'google',
          utm_medium: 'video',
          utm_campaign: campaignData.attribution?.utm_campaign || campaignData.name.toLowerCase().replace(/\s+/g, '-'),
          utm_content: campaignData.attribution?.utm_content,
          utm_term: campaignData.attribution?.utm_term
        },
        googleConfig: {
          campaignType: 'VIDEO',
          campaignSubType: subType,
          campaignResourceName: googleCampaignResourceName,
          budgetResourceName: budgetResourceName,
          biddingStrategy: campaignData.biddingStrategy,
          networkSettings: {
            targetYouTube: true,
            targetGoogleTvNetwork: campaignData.includeGoogleTv || false
          },
          videoSettings: {
            adFormat: adGroupType,
            brandSafety: campaignData.brandSafety || 'EXPANDED_INVENTORY'
          }
        }
      });

      // Create GoogleAdGroup record
      await GoogleAdGroup.create({
        _organization: organizationId,
        _campaign: savedCampaign._id,
        _created_by: userId,
        googleAdGroupId: googleAdGroupId,
        googleCampaignId: googleCampaignId,
        googleCustomerId: connection.customerId,
        name: adGroupData.name,
        status: 'PAUSED',
        type: adGroupType,
        bidding: {
          cpv_bid_micros: adGroupData.cpv_bid_micros
        }
      });

      // Set YouTube-specific targeting
      if (campaignData.audience) {
        await this.setYouTubeAdGroupTargeting(
          client,
          connection.customerId,
          googleAdGroupId,
          campaignData.audience
        );
      }

      // Log campaign creation
      await AuditLog.create({
        _organization: organizationId,
        _user: userId,
        action: 'google_youtube_campaign_created',
        resource: 'Campaign',
        resourceId: savedCampaign._id,
        metadata: {
          campaignName: campaignData.name,
          googleCampaignId: googleCampaignId,
          subType: subType,
          budget: campaignData.budget.amount,
          currency: connection.currencyCode
        }
      });

      await session.commitTransaction();

      // Clear campaign cache
      await redis.del(`campaigns:${organizationId}:*`);

      logger.info('Google YouTube campaign created successfully', {
        organizationId,
        campaignId: savedCampaign._id,
        googleCampaignId
      });

      return {
        success: true,
        campaign: savedCampaign,
        googleCampaignId,
        googleAdGroupId,
        message: 'YouTube campaign created successfully'
      };

    } catch (error) {
      await session.abortTransaction();
      logger.error('Failed to create Google YouTube campaign', error);
      throw this.handleGoogleAdsError(error);
    } finally {
      session.endSession();
    }
  }

  /**
   * Update campaign status (pause/resume)
   * @param {String} campaignId - Campaign ID
   * @param {String} status - New status
   * @param {String} organizationId - Organization ID
   * @param {String} userId - User making the change
   * @returns {Object} Updated campaign
   */
  async updateCampaignStatus(campaignId, status, organizationId, userId) {
    try {
      // Get campaign
      const campaign = await Campaign.findOne({
        _id: campaignId,
        _organization: organizationId,
        platform: { $in: ['google', 'multi'] }
      });

      if (!campaign) {
        throw new UserFriendlyError(
          'Campaign not found',
          'CAMPAIGN_NOT_FOUND'
        );
      }

      if (!campaign.googleCampaignId) {
        throw new UserFriendlyError(
          'Campaign is not connected to Google Ads',
          'NOT_GOOGLE_CAMPAIGN'
        );
      }

      // Map status to Google format
      const googleStatus = this.mapStatusToGoogle(status);

      // Get authenticated client
      const { client, connection } = await this.getAuthenticatedClient(organizationId);

      // Update campaign status in Google
      const operation = {
        update: {
          resource_name: campaign.googleConfig.campaignResourceName,
          status: googleStatus
        },
        update_mask: 'status'
      };

      await client.campaigns.mutate({
        customer_id: connection.customerId,
        operations: [operation]
      });

      // Update ad group status if activating
      if (googleStatus === 'ENABLED' && campaign.googleAdGroupId) {
        await this.updateAdGroupStatus(
          client,
          connection.customerId,
          campaign.googleAdGroupId,
          'ENABLED'
        );
      }

      // Update local campaign
      campaign.status = status;
      campaign._updated_by = userId;
      await campaign.save();

      // Log status change
      await AuditLog.create({
        _organization: organizationId,
        _user: userId,
        action: `google_campaign_${status}`,
        resource: 'Campaign',
        resourceId: campaign._id,
        metadata: {
          campaignName: campaign.name,
          googleCampaignId: campaign.googleCampaignId,
          previousStatus: campaign.status,
          newStatus: status
        }
      });

      // Clear cache
      await redis.del(`campaign:${campaignId}`);
      await redis.del(`campaigns:${organizationId}:*`);

      logger.info('Google campaign status updated', {
        campaignId,
        googleCampaignId: campaign.googleCampaignId,
        newStatus: status
      });

      return {
        success: true,
        campaign,
        message: `Campaign ${status} successfully`
      };

    } catch (error) {
      logger.error('Failed to update Google campaign status', error);
      throw this.handleGoogleAdsError(error);
    }
  }

  /**
   * Sync campaign metrics from Google Ads
   * @param {String} campaignId - Campaign ID
   * @param {String} organizationId - Organization ID
   * @param {Object} dateRange - Optional date range
   * @returns {Object} Updated metrics
   */
  async syncCampaignMetrics(campaignId, organizationId, dateRange = null) {
    try {
      // Get campaign
      const campaign = await Campaign.findOne({
        _id: campaignId,
        _organization: organizationId,
        platform: { $in: ['google', 'multi'] }
      });

      if (!campaign || !campaign.googleCampaignId) {
        throw new UserFriendlyError(
          'Google campaign not found',
          'CAMPAIGN_NOT_FOUND'
        );
      }

      // Get authenticated client
      const { client, connection } = await this.getAuthenticatedClient(organizationId);

      // Build GAQL query
      const query = this.buildMetricsQuery(campaign.googleCampaignId, dateRange);

      // Execute query
      const response = await client.query({
        customer_id: connection.customerId,
        query: query
      });

      // Aggregate metrics
      const metrics = this.aggregateMetrics(response);

      // Update campaign metrics
      campaign.metrics = {
        ...campaign.metrics,
        impressions: metrics.impressions,
        clicks: metrics.clicks,
        spend: metrics.cost_micros / 1000000, // Convert from micros
        cpm: metrics.average_cpm,
        cpc: metrics.average_cpc_micros / 1000000,
        ctr: metrics.ctr,
        conversions: metrics.conversions,
        lastSyncedAt: new Date()
      };

      // Add video metrics if applicable
      if (campaign.googleConfig.campaignType === 'VIDEO') {
        campaign.googleConfig.metrics = {
          videoViews: metrics.video_views,
          videoQuartile25Rate: metrics.video_quartile_p25_rate,
          videoQuartile50Rate: metrics.video_quartile_p50_rate,
          videoQuartile75Rate: metrics.video_quartile_p75_rate,
          videoQuartile100Rate: metrics.video_quartile_p100_rate,
          averageCpv: metrics.average_cpv_micros / 1000000
        };
      }

      await campaign.save();

      // Sync ad group metrics
      if (campaign.googleAdGroupId) {
        await this.syncAdGroupMetrics(
          client,
          connection.customerId,
          campaign.googleAdGroupId,
          dateRange
        );
      }

      // Update connection API usage
      await connection.incrementApiOperations(2); // Query + potential ad group query

      // Cache metrics
      await redis.setex(
        `campaign:${campaignId}:metrics`,
        config.cache.ttl.campaignMetrics,
        JSON.stringify(metrics)
      );

      logger.info('Google campaign metrics synced', {
        campaignId,
        googleCampaignId: campaign.googleCampaignId,
        impressions: metrics.impressions,
        clicks: metrics.clicks,
        spend: metrics.cost_micros / 1000000
      });

      return {
        success: true,
        metrics: campaign.metrics,
        message: 'Campaign metrics synced successfully'
      };

    } catch (error) {
      logger.error('Failed to sync Google campaign metrics', error);
      throw this.handleGoogleAdsError(error);
    }
  }

  /**
   * Update campaign budget
   * @param {String} campaignId - Campaign ID
   * @param {Object} budgetUpdate - New budget configuration
   * @param {String} organizationId - Organization ID
   * @param {String} userId - User making the change
   * @returns {Object} Updated campaign
   */
  async updateCampaignBudget(campaignId, budgetUpdate, organizationId, userId) {
    try {
      // Get campaign
      const campaign = await Campaign.findOne({
        _id: campaignId,
        _organization: organizationId,
        platform: { $in: ['google', 'multi'] }
      });

      if (!campaign || !campaign.googleCampaignId) {
        throw new UserFriendlyError(
          'Google campaign not found',
          'CAMPAIGN_NOT_FOUND'
        );
      }

      // Get authenticated client
      const { client, connection } = await this.getAuthenticatedClient(organizationId);

      // Validate new budget
      this.validateBudget(budgetUpdate, connection.currencyCode);

      // Update budget in Google Ads
      const budgetOperation = {
        update: {
          resource_name: campaign.googleConfig.budgetResourceName,
          amount_micros: this.convertToMicros(budgetUpdate.amount, connection.currencyCode)
        },
        update_mask: 'amount_micros'
      };

      await client.campaignBudgets.mutate({
        customer_id: connection.customerId,
        operations: [budgetOperation]
      });

      // Update local campaign
      const previousBudget = campaign.budget.amount;
      campaign.budget = {
        ...campaign.budget,
        ...budgetUpdate
      };
      campaign._updated_by = userId;
      await campaign.save();

      // Log budget change
      await AuditLog.create({
        _organization: organizationId,
        _user: userId,
        action: 'google_campaign_budget_updated',
        resource: 'Campaign',
        resourceId: campaign._id,
        metadata: {
          campaignName: campaign.name,
          googleCampaignId: campaign.googleCampaignId,
          previousBudget,
          newBudget: budgetUpdate.amount,
          currency: connection.currencyCode
        }
      });

      // Clear cache
      await redis.del(`campaign:${campaignId}`);

      logger.info('Google campaign budget updated', {
        campaignId,
        googleCampaignId: campaign.googleCampaignId,
        previousBudget,
        newBudget: budgetUpdate.amount
      });

      return {
        success: true,
        campaign,
        message: 'Campaign budget updated successfully'
      };

    } catch (error) {
      logger.error('Failed to update Google campaign budget', error);
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
   * Create campaign budget
   */
  async createCampaignBudget(client, customerId, budgetData) {
    const operation = {
      create: {
        name: budgetData.name,
        amount_micros: budgetData.amount_micros,
        delivery_method: budgetData.delivery_method || 'STANDARD',
        explicitly_shared: budgetData.explicitly_shared || false
      }
    };

    const response = await client.campaignBudgets.mutate({
      customer_id: customerId,
      operations: [operation]
    });

    return response.results[0].resource_name;
  }

  /**
   * Create ad group
   */
  async createAdGroup(client, customerId, adGroupData) {
    const operation = {
      create: {
        name: adGroupData.name,
        campaign: adGroupData.campaign,
        status: adGroupData.status || 'PAUSED',
        type: adGroupData.type,
        ad_rotation_mode: adGroupData.ad_rotation_mode || 'OPTIMIZE'
      }
    };

    // Add bidding based on type
    if (adGroupData.cpc_bid_micros) {
      operation.create.cpc_bid_micros = adGroupData.cpc_bid_micros;
    }
    if (adGroupData.cpm_bid_micros) {
      operation.create.cpm_bid_micros = adGroupData.cpm_bid_micros;
    }
    if (adGroupData.cpv_bid_micros) {
      operation.create.cpv_bid_micros = adGroupData.cpv_bid_micros;
    }
    if (adGroupData.target_cpa_micros) {
      operation.create.target_cpa = { target_cpa_micros: adGroupData.target_cpa_micros };
    }

    const response = await client.adGroups.mutate({
      customer_id: customerId,
      operations: [operation]
    });

    return response.results[0].resource_name;
  }

  /**
   * Convert amount to micros based on currency
   */
  convertToMicros(amount, currencyCode) {
    // Handle currencies without decimal places
    const noDecimalCurrencies = ['JPY', 'KRW', 'TWD', 'CLP', 'COP', 'IDR', 'VND'];
    
    if (noDecimalCurrencies.includes(currencyCode)) {
      return Math.round(amount * 1000000);
    }
    
    // Standard currencies with 2 decimal places
    return Math.round(amount * 1000000);
  }

  /**
   * Validate budget meets minimum requirements
   */
  validateBudget(budget, currencyCode) {
    const minimumBudget = config.getMinimumBudget(currencyCode);
    
    if (budget.amount < minimumBudget) {
      throw new UserFriendlyError(
        `Budget must be at least ${minimumBudget} ${currencyCode}`,
        'BUDGET_TOO_LOW',
        { minimum: minimumBudget, currency: currencyCode }
      );
    }
  }

  /**
   * Build bidding strategy configuration
   */
  buildBiddingStrategy(biddingStrategy) {
    const strategy = {};

    switch (biddingStrategy.type) {
      case 'MAXIMIZE_CLICKS':
        strategy.maximize_clicks = {
          target_spend_micros: biddingStrategy.targetSpend 
            ? this.convertToMicros(biddingStrategy.targetSpend) 
            : undefined
        };
        break;
      
      case 'TARGET_CPA':
        strategy.target_cpa = {
          target_cpa_micros: this.convertToMicros(biddingStrategy.targetCpa),
          cpc_bid_ceiling_micros: biddingStrategy.cpcBidCeiling 
            ? this.convertToMicros(biddingStrategy.cpcBidCeiling) 
            : undefined
        };
        break;
      
      case 'TARGET_ROAS':
        strategy.target_roas = {
          target_roas: biddingStrategy.targetRoas,
          cpc_bid_ceiling_micros: biddingStrategy.cpcBidCeiling 
            ? this.convertToMicros(biddingStrategy.cpcBidCeiling) 
            : undefined
        };
        break;
      
      case 'MAXIMIZE_CONVERSIONS':
        strategy.maximize_conversions = {
          target_cpa_micros: biddingStrategy.targetCpa 
            ? this.convertToMicros(biddingStrategy.targetCpa) 
            : undefined
        };
        break;
      
      default:
        // Manual CPC
        strategy.manual_cpc = {
          enhanced_cpc_enabled: true
        };
    }

    return strategy;
  }

  /**
   * Build video bidding strategy
   */
  buildVideoBiddingStrategy(biddingStrategy, subType) {
    // Video campaigns have specific bidding requirements based on goal
    if (subType === 'VIDEO_ACTION') {
      return {
        target_cpa: {
          target_cpa_micros: this.convertToMicros(biddingStrategy.targetCpa || 10)
        }
      };
    }
    
    // For awareness campaigns, use CPV bidding at ad group level
    return {
      manual_cpv: {
        // CPV is set at ad group level
      }
    };
  }

  /**
   * Set campaign geo targeting
   */
  async setCampaignGeoTargeting(client, customerId, campaignId, locations) {
    const operations = [];

    for (const location of locations) {
      // Get geo target constant
      const geoTargetConstant = await this.getGeoTargetConstant(
        client,
        location.key || location.name
      );

      if (geoTargetConstant) {
        operations.push({
          create: {
            campaign: `customers/${customerId}/campaigns/${campaignId}`,
            location: geoTargetConstant,
            negative: false
          }
        });
      }
    }

    if (operations.length > 0) {
      await client.campaignCriteria.mutate({
        customer_id: customerId,
        operations: operations
      });
    }
  }

  /**
   * Get geo target constant from Google
   */
  async getGeoTargetConstant(client, locationName) {
    // Check cache first
    if (this.geoTargetCache.has(locationName)) {
      return this.geoTargetCache.get(locationName);
    }

    try {
      const response = await client.geoTargetConstants.suggest({
        locale: 'en',
        country_code: 'US',
        location_names: {
          names: [locationName]
        }
      });

      if (response.geo_target_constant_suggestions?.length > 0) {
        const suggestion = response.geo_target_constant_suggestions[0];
        const resourceName = suggestion.geo_target_constant.resource_name;
        
        // Cache for future use
        this.geoTargetCache.set(locationName, resourceName);
        
        return resourceName;
      }
    } catch (error) {
      logger.warn(`Failed to find geo target for: ${locationName}`, error);
    }

    return null;
  }

  /**
   * Set ad group targeting
   */
  async setAdGroupTargeting(client, customerId, adGroupId, audience) {
    const operations = [];

    // Interest targeting
    if (audience.interests?.length > 0) {
      for (const interest of audience.interests) {
        operations.push({
          create: {
            ad_group: `customers/${customerId}/adGroups/${adGroupId}`,
            user_interest: {
              user_interest_category: `customers/${customerId}/userInterests/${interest.id}`
            }
          }
        });
      }
    }

    // Custom audience targeting
    if (audience.custom_audiences?.length > 0) {
      for (const audienceId of audience.custom_audiences) {
        operations.push({
          create: {
            ad_group: `customers/${customerId}/adGroups/${adGroupId}`,
            user_list: {
              user_list: `customers/${customerId}/userLists/${audienceId}`
            }
          }
        });
      }
    }

    if (operations.length > 0) {
      await client.adGroupCriteria.mutate({
        customer_id: customerId,
        operations: operations
      });
    }
  }

  /**
   * Set YouTube-specific ad group targeting
   */
  async setYouTubeAdGroupTargeting(client, customerId, adGroupId, audience) {
    const operations = [];

    // YouTube channels
    if (audience.youtube_channels?.length > 0) {
      for (const channelId of audience.youtube_channels) {
        operations.push({
          create: {
            ad_group: `customers/${customerId}/adGroups/${adGroupId}`,
            youtube_channel: {
              channel_id: channelId
            }
          }
        });
      }
    }

    // YouTube videos
    if (audience.youtube_videos?.length > 0) {
      for (const videoId of audience.youtube_videos) {
        operations.push({
          create: {
            ad_group: `customers/${customerId}/adGroups/${adGroupId}`,
            youtube_video: {
              video_id: videoId
            }
          }
        });
      }
    }

    // Also set standard targeting
    await this.setAdGroupTargeting(client, customerId, adGroupId, audience);

    if (operations.length > 0) {
      await client.adGroupCriteria.mutate({
        customer_id: customerId,
        operations: operations
      });
    }
  }

  /**
   * Map internal status to Google status
   */
  mapStatusToGoogle(status) {
    const statusMap = {
      'active': 'ENABLED',
      'paused': 'PAUSED',
      'draft': 'PAUSED',
      'completed': 'PAUSED',
      'error': 'PAUSED'
    };

    return statusMap[status] || 'PAUSED';
  }

  /**
   * Get video ad group type based on format
   */
  getVideoAdGroupType(adFormat) {
    const formatMap = {
      'in_stream': 'VIDEO_TRUE_VIEW_IN_STREAM',
      'discovery': 'VIDEO_TRUE_VIEW_IN_DISPLAY',
      'bumper': 'VIDEO_BUMPER',
      'non_skippable': 'VIDEO_NON_SKIPPABLE'
    };

    return formatMap[adFormat] || 'VIDEO_TRUE_VIEW_IN_STREAM';
  }

  /**
   * Build GAQL query for metrics
   */
  buildMetricsQuery(campaignId, dateRange) {
    const selectClause = `
      SELECT 
        campaign.id,
        campaign.name,
        campaign.status,
        metrics.impressions,
        metrics.clicks,
        metrics.cost_micros,
        metrics.average_cpc,
        metrics.average_cpm,
        metrics.ctr,
        metrics.conversions,
        metrics.conversions_value,
        metrics.video_views,
        metrics.video_quartile_p25_rate,
        metrics.video_quartile_p50_rate,
        metrics.video_quartile_p75_rate,
        metrics.video_quartile_p100_rate,
        metrics.average_cpv
    `;

    const fromClause = 'FROM campaign';
    
    const whereClause = `WHERE campaign.id = ${campaignId}`;
    
    let dateClause = '';
    if (dateRange) {
      dateClause = ` AND segments.date BETWEEN '${dateRange.startDate}' AND '${dateRange.endDate}'`;
    } else {
      dateClause = ' AND segments.date DURING LAST_30_DAYS';
    }

    return `${selectClause} ${fromClause} ${whereClause}${dateClause}`;
  }

  /**
   * Aggregate metrics from Google Ads response
   */
  aggregateMetrics(response) {
    const aggregated = {
      impressions: 0,
      clicks: 0,
      cost_micros: 0,
      conversions: 0,
      conversions_value: 0,
      video_views: 0,
      video_quartile_p25_rate: 0,
      video_quartile_p50_rate: 0,
      video_quartile_p75_rate: 0,
      video_quartile_p100_rate: 0
    };

    for (const row of response) {
      aggregated.impressions += row.metrics.impressions || 0;
      aggregated.clicks += row.metrics.clicks || 0;
      aggregated.cost_micros += row.metrics.cost_micros || 0;
      aggregated.conversions += row.metrics.conversions || 0;
      aggregated.conversions_value += row.metrics.conversions_value || 0;
      aggregated.video_views += row.metrics.video_views || 0;
    }

    // Calculate averages
    if (aggregated.impressions > 0) {
      aggregated.ctr = (aggregated.clicks / aggregated.impressions) * 100;
      aggregated.average_cpm = (aggregated.cost_micros / aggregated.impressions) * 1000;
    }

    if (aggregated.clicks > 0) {
      aggregated.average_cpc_micros = aggregated.cost_micros / aggregated.clicks;
    }

    if (aggregated.video_views > 0) {
      aggregated.average_cpv_micros = aggregated.cost_micros / aggregated.video_views;
      
      // Use latest video completion rates
      const lastRow = response[response.length - 1];
      if (lastRow?.metrics) {
        aggregated.video_quartile_p25_rate = lastRow.metrics.video_quartile_p25_rate || 0;
        aggregated.video_quartile_p50_rate = lastRow.metrics.video_quartile_p50_rate || 0;
        aggregated.video_quartile_p75_rate = lastRow.metrics.video_quartile_p75_rate || 0;
        aggregated.video_quartile_p100_rate = lastRow.metrics.video_quartile_p100_rate || 0;
      }
    }

    return aggregated;
  }

  /**
   * Update ad group status
   */
  async updateAdGroupStatus(client, customerId, adGroupId, status) {
    const operation = {
      update: {
        resource_name: `customers/${customerId}/adGroups/${adGroupId}`,
        status: status
      },
      update_mask: 'status'
    };

    await client.adGroups.mutate({
      customer_id: customerId,
      operations: [operation]
    });
  }

  /**
   * Sync ad group metrics
   */
  async syncAdGroupMetrics(client, customerId, adGroupId, dateRange) {
    const query = `
      SELECT 
        ad_group.id,
        metrics.impressions,
        metrics.clicks,
        metrics.cost_micros,
        metrics.conversions,
        metrics.conversions_value,
        metrics.video_views
      FROM ad_group
      WHERE ad_group.id = ${adGroupId}
      ${dateRange ? 
        `AND segments.date BETWEEN '${dateRange.startDate}' AND '${dateRange.endDate}'` : 
        'AND segments.date DURING LAST_30_DAYS'}
    `;

    const response = await client.query({
      customer_id: customerId,
      query: query
    });

    if (response.length > 0) {
      const metrics = this.aggregateMetrics(response);
      
      // Update GoogleAdGroup record
      await GoogleAdGroup.findOneAndUpdate(
        { googleAdGroupId: adGroupId },
        {
          $set: {
            'metrics.impressions': metrics.impressions,
            'metrics.clicks': metrics.clicks,
            'metrics.cost_micros': metrics.cost_micros,
            'metrics.conversions': metrics.conversions,
            'metrics.conversion_value': metrics.conversions_value,
            'metrics.video_views': metrics.video_views,
            'metrics.last_sync_at': new Date()
          }
        }
      );
    }
  }

  /**
   * Format date for Google Ads API
   */
  formatDateForGoogle(date) {
    const d = new Date(date);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}${month}${day}`;
  }

  /**
   * Handle Google Ads API errors
   */
  handleGoogleAdsError(error) {
    const errorDetails = error.errors?.[0] || error;
    
    const errorMappings = {
      'INSUFFICIENT_ACCESS': 'Your Google Ads account lacks necessary permissions. Please ensure you have campaign management access.',
      'BUDGET_AMOUNT_TOO_SMALL': 'The budget amount is below Google\'s minimum requirements for your target location.',
      'DUPLICATE_CAMPAIGN_NAME': 'A campaign with this name already exists in your account.',
      'INVALID_CUSTOMER_ID': 'The selected Google Ads account is invalid or inaccessible.',
      'QUOTA_EXCEEDED': 'You\'ve reached Google Ads API limits. Please try again in a few minutes.',
      'BILLING_SETUP_REQUIRED': 'Your Google Ads account needs billing information before creating campaigns.',
      'AD_GROUP_REQUIRED': 'Campaign must have at least one ad group.',
      'INVALID_GEO_TARGET': 'One or more location targets are invalid.',
      'CURRENCY_MISMATCH': 'Budget currency must match your account currency.'
    };

    const userMessage = errorMappings[errorDetails.error_code?.error_code] || 
                       'Failed to complete Google Ads operation. Please check your account settings.';

    const errorCode = errorDetails.error_code?.error_code || 'GOOGLE_ADS_ERROR';
    
    // Check if it's a quota error
    if (config.errors.quotaErrors.includes(errorCode)) {
      return new UserFriendlyError(
        'API quota exceeded. Please wait a few minutes and try again.',
        'QUOTA_EXCEEDED',
        { resetTime: new Date(Date.now() + 300000) } // 5 minutes
      );
    }

    // Check if it's an auth error
    if (config.errors.authErrors.includes(errorCode)) {
      return new UserFriendlyError(
        'Authentication failed. Please reconnect your Google Ads account.',
        'AUTH_REQUIRED'
      );
    }

    return new UserFriendlyError(userMessage, errorCode, {
      originalError: errorDetails.message,
      fieldPath: errorDetails.location?.field_path_elements,
      trigger: errorDetails.trigger?.string_value
    });
  }
}

module.exports = new GoogleCampaignService();