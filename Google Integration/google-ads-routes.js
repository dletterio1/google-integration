const express = require('express');
const router = express.Router();

// Controllers
const googleAuthController = require('../../controllers/adbuilder/google-ads/google-auth.controller');
const googleCampaignController = require('../../controllers/adbuilder/google-ads/google-campaign.controller');
const googleAudienceController = require('../../controllers/adbuilder/google-ads/google-audience.controller');
// const googleAssetController = require('../../controllers/adbuilder/google-ads/google-asset.controller');

// Middleware
const { AuthMiddleware } = require('../../middleware/auth.middleware');
const { OrganizationMiddleware } = require('../../middleware/organization.middleware');
const GoogleAdsAuthMiddleware = require('../../middleware/google-ads-auth.middleware');
const { validateRequest } = require('../../middleware/validation.middleware');
const { rateLimiter } = require('../../middleware/rateLimiter.middleware');
const upload = require('../../middleware/upload.middleware');

// Validation schemas
const {
  createDisplayCampaignSchema,
  createYouTubeCampaignSchema,
  updateCampaignSchema,
  updateCampaignStatusSchema,
  syncMetricsSchema,
  bulkSyncMetricsSchema,
  switchAccountSchema
} = require('../../validators/google-ads/google-campaign-validation.schemas');

const {
  createCustomerMatchSchema,
  createLookalikeSchema,
  updateAudienceSchema,
  createFromUploadSchema,
  searchInterestsQuerySchema,
  getTargetingSuggestionsSchema,
  uploadAssetSchema,
  linkYouTubeVideoSchema
} = require('../../validators/google-ads/google-audience-validation.schemas');

// Apply rate limiting to all Google Ads routes
router.use(rateLimiter({
  windowMs: 60 * 1000, // 1 minute
  max: 60, // 60 requests per minute
  message: 'Too many requests to Google Ads API, please try again later.'
}));

/**
 * Google OAuth Routes
 * These handle the connection flow with Google Ads
 */

// Initiate Google Ads OAuth connection
router.get('/auth/google/connect',
  AuthMiddleware.authenticate,
  OrganizationMiddleware.validateOrganization,
  googleAuthController.initiateConnection
);

// Handle OAuth callback from Google (PUBLIC endpoint)
// This endpoint is called by Google and validates state internally
router.get('/auth/google/callback',
  googleAuthController.handleCallback
);

// Get connection status
router.get('/auth/google/status',
  AuthMiddleware.authenticate,
  OrganizationMiddleware.validateOrganization,
  googleAuthController.getConnectionStatus
);

// Get accessible Google Ads accounts
router.get('/auth/google/accounts',
  AuthMiddleware.authenticate,
  OrganizationMiddleware.validateOrganization,
  googleAuthController.getAccessibleAccounts
);

// Switch active Google Ads account
router.post('/auth/google/switch-account',
  AuthMiddleware.authenticate,
  OrganizationMiddleware.validateOrganization,
  validateRequest(switchAccountSchema),
  googleAuthController.switchAccount
);

// Refresh Google Ads connection
router.post('/auth/google/refresh',
  AuthMiddleware.authenticate,
  OrganizationMiddleware.validateOrganization,
  googleAuthController.refreshConnection
);

// Test Google Ads API connection
router.post('/auth/google/test',
  AuthMiddleware.authenticate,
  OrganizationMiddleware.validateOrganization,
  googleAuthController.testConnection
);

// Disconnect Google Ads
router.delete('/auth/google/disconnect',
  AuthMiddleware.authenticate,
  OrganizationMiddleware.validateOrganization,
  googleAuthController.disconnect
);

/**
 * Campaign Management Routes
 */

// Create Display campaign
router.post('/google/campaigns/display',
  AuthMiddleware.authenticate,
  OrganizationMiddleware.validateOrganization,
  GoogleAdsAuthMiddleware.requireConnection,
  GoogleAdsAuthMiddleware.rateLimitGoogleAPI,
  validateRequest(createDisplayCampaignSchema),
  GoogleAdsAuthMiddleware.trackApiUsage,
  googleCampaignController.createDisplayCampaign
);

// Create YouTube campaign
router.post('/google/campaigns/youtube',
  AuthMiddleware.authenticate,
  OrganizationMiddleware.validateOrganization,
  GoogleAdsAuthMiddleware.requireConnection,
  GoogleAdsAuthMiddleware.rateLimitGoogleAPI,
  validateRequest(createYouTubeCampaignSchema),
  GoogleAdsAuthMiddleware.trackApiUsage,
  googleCampaignController.createYouTubeCampaign
);

// Get campaign details
router.get('/google/campaigns/:campaignId',
  AuthMiddleware.authenticate,
  OrganizationMiddleware.validateOrganization,
  GoogleAdsAuthMiddleware.requireConnection,
  GoogleAdsAuthMiddleware.validateCampaignOwnership,
  googleCampaignController.getCampaignDetails
);

// Update campaign
router.put('/google/campaigns/:campaignId',
  AuthMiddleware.authenticate,
  OrganizationMiddleware.validateOrganization,
  GoogleAdsAuthMiddleware.requireConnection,
  GoogleAdsAuthMiddleware.validateCampaignOwnership,
  GoogleAdsAuthMiddleware.rateLimitGoogleAPI,
  validateRequest(updateCampaignSchema),
  GoogleAdsAuthMiddleware.trackApiUsage,
  googleCampaignController.updateCampaign
);

// Pause/Resume campaign
router.patch('/google/campaigns/:campaignId/status',
  AuthMiddleware.authenticate,
  OrganizationMiddleware.validateOrganization,
  GoogleAdsAuthMiddleware.requireConnection,
  GoogleAdsAuthMiddleware.validateCampaignOwnership,
  GoogleAdsAuthMiddleware.rateLimitGoogleAPI,
  validateRequest(updateCampaignStatusSchema),
  GoogleAdsAuthMiddleware.trackApiUsage,
  googleCampaignController.updateCampaignStatus
);

// Sync campaign metrics
router.post('/google/campaigns/:campaignId/sync',
  AuthMiddleware.authenticate,
  OrganizationMiddleware.validateOrganization,
  GoogleAdsAuthMiddleware.requireConnection,
  GoogleAdsAuthMiddleware.validateCampaignOwnership,
  GoogleAdsAuthMiddleware.rateLimitGoogleAPI,
  validateRequest(syncMetricsSchema),
  GoogleAdsAuthMiddleware.trackApiUsage,
  googleCampaignController.syncMetrics
);

// Get campaign performance report
router.get('/google/campaigns/:campaignId/performance',
  AuthMiddleware.authenticate,
  OrganizationMiddleware.validateOrganization,
  GoogleAdsAuthMiddleware.requireConnection,
  GoogleAdsAuthMiddleware.validateCampaignOwnership,
  googleCampaignController.getPerformanceReport
);

// Bulk sync campaigns
router.post('/google/campaigns/sync-all',
  AuthMiddleware.authenticate,
  OrganizationMiddleware.validateOrganization,
  GoogleAdsAuthMiddleware.requireConnection,
  GoogleAdsAuthMiddleware.rateLimitGoogleAPI,
  validateRequest(bulkSyncMetricsSchema),
  GoogleAdsAuthMiddleware.trackApiUsage,
  googleCampaignController.bulkSyncMetrics
);

// Get campaign suggestions
router.get('/google/campaigns/suggestions',
  AuthMiddleware.authenticate,
  OrganizationMiddleware.validateOrganization,
  GoogleAdsAuthMiddleware.requireConnection,
  googleCampaignController.getCampaignSuggestions
);

/**
 * Audience Management Routes
 */

// Create customer match audience
router.post('/google/audiences/customer-match',
  AuthMiddleware.authenticate,
  OrganizationMiddleware.validateOrganization,
  GoogleAdsAuthMiddleware.requireConnection,
  GoogleAdsAuthMiddleware.rateLimitGoogleAPI,
  validateRequest(createCustomerMatchSchema),
  GoogleAdsAuthMiddleware.trackApiUsage,
  googleAudienceController.createCustomerMatch
);

// Create lookalike audience
router.post('/google/audiences/lookalike',
  AuthMiddleware.authenticate,
  OrganizationMiddleware.validateOrganization,
  GoogleAdsAuthMiddleware.requireConnection,
  GoogleAdsAuthMiddleware.rateLimitGoogleAPI,
  validateRequest(createLookalikeSchema),
  GoogleAdsAuthMiddleware.trackApiUsage,
  googleAudienceController.createLookalike
);

// Get audiences list
router.get('/google/audiences',
  AuthMiddleware.authenticate,
  OrganizationMiddleware.validateOrganization,
  GoogleAdsAuthMiddleware.requireConnection,
  googleAudienceController.getAudiences
);

// Get audience details
router.get('/google/audiences/:audienceId',
  AuthMiddleware.authenticate,
  OrganizationMiddleware.validateOrganization,
  GoogleAdsAuthMiddleware.requireConnection,
  GoogleAdsAuthMiddleware.validateAudienceOwnership,
  googleAudienceController.getAudienceDetails
);

// Get audience estimate
router.get('/google/audiences/:audienceId/estimate',
  AuthMiddleware.authenticate,
  OrganizationMiddleware.validateOrganization,
  GoogleAdsAuthMiddleware.requireConnection,
  GoogleAdsAuthMiddleware.validateAudienceOwnership,
  GoogleAdsAuthMiddleware.rateLimitGoogleAPI,
  GoogleAdsAuthMiddleware.trackApiUsage,
  googleAudienceController.getAudienceEstimate
);

// Update audience
router.put('/google/audiences/:audienceId',
  AuthMiddleware.authenticate,
  OrganizationMiddleware.validateOrganization,
  GoogleAdsAuthMiddleware.requireConnection,
  GoogleAdsAuthMiddleware.validateAudienceOwnership,
  GoogleAdsAuthMiddleware.rateLimitGoogleAPI,
  validateRequest(updateAudienceSchema),
  GoogleAdsAuthMiddleware.trackApiUsage,
  googleAudienceController.updateAudience
);

// Delete audience
router.delete('/google/audiences/:audienceId',
  AuthMiddleware.authenticate,
  OrganizationMiddleware.validateOrganization,
  GoogleAdsAuthMiddleware.requireConnection,
  GoogleAdsAuthMiddleware.validateAudienceOwnership,
  GoogleAdsAuthMiddleware.rateLimitGoogleAPI,
  GoogleAdsAuthMiddleware.trackApiUsage,
  googleAudienceController.deleteAudience
);

// Create audience from CSV upload
router.post('/google/audiences/upload',
  AuthMiddleware.authenticate,
  OrganizationMiddleware.validateOrganization,
  GoogleAdsAuthMiddleware.requireConnection,
  GoogleAdsAuthMiddleware.rateLimitGoogleAPI,
  upload.single('file'),
  validateRequest(createFromUploadSchema),
  GoogleAdsAuthMiddleware.trackApiUsage,
  googleAudienceController.createFromUpload
);

// Search for interests
router.get('/google/targeting/interests',
  AuthMiddleware.authenticate,
  OrganizationMiddleware.validateOrganization,
  GoogleAdsAuthMiddleware.requireConnection,
  validateRequest(searchInterestsQuerySchema),
  googleAudienceController.searchInterests
);

// Get demographic options
router.get('/google/targeting/demographics',
  AuthMiddleware.authenticate,
  OrganizationMiddleware.validateOrganization,
  GoogleAdsAuthMiddleware.requireConnection,
  googleAudienceController.getDemographicOptions
);

// Get targeting suggestions
router.post('/google/targeting/suggestions',
  AuthMiddleware.authenticate,
  OrganizationMiddleware.validateOrganization,
  GoogleAdsAuthMiddleware.requireConnection,
  GoogleAdsAuthMiddleware.rateLimitGoogleAPI,
  validateRequest(getTargetingSuggestionsSchema),
  GoogleAdsAuthMiddleware.trackApiUsage,
  googleAudienceController.getTargetingSuggestions
);

// Get available locations for targeting
router.get('/google/targeting/locations',
  AuthMiddleware.authenticate,
  OrganizationMiddleware.validateOrganization,
  GoogleAdsAuthMiddleware.requireConnection,
  googleCampaignController.getAvailableLocations
);

/**
 * Asset Management Routes
 * Note: Using existing asset service with Google-specific endpoints
 */

// Upload display asset
// router.post('/google/assets/display',
//   AuthMiddleware.authenticate,
//   OrganizationMiddleware.validateOrganization,
//   GoogleAdsAuthMiddleware.requireConnection,
//   upload.single('asset'),
//   validateRequest(uploadAssetSchema),
//   googleAssetController.uploadDisplayAsset
// );

// Link YouTube video
// router.post('/google/assets/video',
//   AuthMiddleware.authenticate,
//   OrganizationMiddleware.validateOrganization,
//   GoogleAdsAuthMiddleware.requireConnection,
//   validateRequest(linkYouTubeVideoSchema),
//   googleAssetController.linkYouTubeVideo
// );

// Export router
module.exports = router;