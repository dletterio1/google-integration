/**
 * Google Ads API Configuration
 * Centralizes all Google Ads related settings and constants
 */

module.exports = {
  // API Settings
  api: {
    version: process.env.GOOGLE_ADS_API_VERSION || 'v18',
    baseUrl: 'https://googleads.googleapis.com',
    timeout: 120000, // 2 minutes for large operations
    retryAttempts: 3,
    retryDelay: 1000 // 1 second base delay
  },

  // OAuth Configuration
  oauth: {
    authorizationBaseUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: [
      'https://www.googleapis.com/auth/adwords', // Full Google Ads access
      'https://www.googleapis.com/auth/userinfo.email', // User email
      'https://www.googleapis.com/auth/userinfo.profile' // User profile
    ],
    clientId: process.env.GOOGLE_ADS_CLIENT_ID,
    clientSecret: process.env.GOOGLE_ADS_CLIENT_SECRET,
    redirectUri: process.env.GOOGLE_ADS_OAUTH_REDIRECT_URI,
    accessType: 'offline', // Required for refresh tokens
    prompt: 'consent' // Force consent to ensure refresh token
  },

  // Developer Settings
  developer: {
    token: process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
    validateOnly: process.env.NODE_ENV === 'development', // Test mode in dev
    enablePartialFailure: true // Continue on partial errors
  },

  // Customer Settings
  customer: {
    managerAccountId: process.env.GOOGLE_ADS_MANAGER_CUSTOMER_ID,
    testAccountId: process.env.GOOGLE_ADS_TEST_CUSTOMER_ID,
    loginCustomerId: process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || process.env.GOOGLE_ADS_MANAGER_CUSTOMER_ID
  },

  // Rate Limiting (per Google's documentation)
  rateLimits: {
    daily: {
      basic: 15000, // Basic access operations per day
      standard: 5000000 // Standard access operations per day
    },
    perSecond: {
      basic: 1000, // Basic access QPS
      standard: 10000 // Standard access QPS
    },
    mutateOperations: {
      maxPerRequest: 5000, // Max operations per mutate request
      recommendedPerRequest: 1000 // Recommended for performance
    }
  },

  // Operation Costs (for quota tracking)
  operationCosts: {
    // Read operations
    search: 1,
    searchStream: 1,
    get: 1,
    
    // Write operations (cost more)
    mutate: 10,
    batchJobOperations: 5,
    offlineUserDataJob: 20,
    
    // Resource intensive operations
    audienceInsights: 50,
    reachPlanService: 100,
    keywordPlanService: 100
  },

  // Campaign Settings
  campaign: {
    // Minimum budgets by currency (in base units)
    minimumBudgets: {
      USD: 1.00,
      EUR: 1.00,
      GBP: 1.00,
      COP: 250000, // Colombian Peso
      MXN: 10.00,
      BRL: 5.00,
      JPY: 100, // Japanese Yen (no decimals)
      INR: 50.00
    },
    
    // Default settings
    defaults: {
      deliveryMethod: 'STANDARD',
      networkSettings: {
        display: {
          targetGoogleSearch: false,
          targetSearchNetwork: false,
          targetContentNetwork: true,
          targetPartnerSearchNetwork: false
        },
        youtube: {
          targetYouTube: true,
          targetGoogleTvNetwork: false,
          targetGoogleSearch: false,
          targetSearchNetwork: false,
          targetContentNetwork: false,
          targetPartnerSearchNetwork: false
        }
      }
    }
  },

  // Audience Settings
  audience: {
    customerMatch: {
      uploadKeyType: 'CONTACT_INFO',
      dataSourceType: 'FIRST_PARTY',
      maxRecordsPerBatch: 100000,
      minAudienceSize: 1000,
      retentionDays: {
        min: 1,
        max: 540,
        default: 30
      }
    },
    lookalike: {
      minSeedSize: 100,
      maxSeedSize: 10000000,
      ratios: [0.01, 0.02, 0.03, 0.04, 0.05, 0.10], // 1% to 10%
      defaultRatio: 0.03 // 3%
    }
  },

  // Creative Specifications
  creative: {
    display: {
      supportedFormats: ['IMAGE', 'HTML5', 'NATIVE'],
      imageSizes: [
        { width: 728, height: 90, name: 'Leaderboard' },
        { width: 300, height: 250, name: 'Medium Rectangle' },
        { width: 336, height: 280, name: 'Large Rectangle' },
        { width: 320, height: 50, name: 'Mobile Banner' },
        { width: 320, height: 100, name: 'Large Mobile Banner' },
        { width: 250, height: 250, name: 'Square' },
        { width: 200, height: 200, name: 'Small Square' },
        { width: 468, height: 60, name: 'Banner' },
        { width: 300, height: 600, name: 'Half Page' },
        { width: 160, height: 600, name: 'Wide Skyscraper' },
        { width: 970, height: 90, name: 'Large Leaderboard' },
        { width: 970, height: 250, name: 'Billboard' }
      ],
      maxFileSize: 150 * 1024, // 150KB
      supportedMimeTypes: ['image/jpeg', 'image/png', 'image/gif']
    },
    video: {
      supportedFormats: ['MP4', 'MOV', 'AVI', 'FLV', 'WMV'],
      maxFileSize: 1.75 * 1024 * 1024 * 1024, // 1.75GB
      minDuration: 6, // seconds
      maxDuration: 180, // 3 minutes
      aspectRatios: ['16:9', '4:3', '1:1', '9:16'], // Including vertical
      recommendedResolutions: {
        '16:9': { width: 1920, height: 1080 },
        '4:3': { width: 640, height: 480 },
        '1:1': { width: 1080, height: 1080 },
        '9:16': { width: 1080, height: 1920 }
      }
    }
  },

  // Error Handling
  errors: {
    retryableCodes: [
      'DEADLINE_EXCEEDED',
      'RESOURCE_EXHAUSTED',
      'INTERNAL_ERROR',
      'UNAVAILABLE'
    ],
    quotaErrors: [
      'QUOTA_EXCEEDED',
      'RATE_EXCEEDED',
      'RESOURCE_EXHAUSTED'
    ],
    authErrors: [
      'UNAUTHENTICATED',
      'PERMISSION_DENIED',
      'AUTHORIZATION_ERROR'
    ]
  },

  // Conversion Tracking
  conversion: {
    defaultSettings: {
      countingType: 'ONE_PER_CLICK',
      clickthroughLookbackWindow: 30,
      viewThroughLookbackWindow: 1,
      includeInConversionsMetric: true,
      attributionModel: 'DATA_DRIVEN' // Falls back to LAST_CLICK if not available
    },
    categories: [
      'PURCHASE',
      'SIGNUP',
      'LEAD',
      'PAGE_VIEW',
      'DOWNLOAD',
      'OTHER'
    ]
  },

  // Geo Targeting
  geoTargeting: {
    locationTypes: ['COUNTRY', 'TERRITORY', 'PROVINCE', 'CITY', 'POSTAL_CODE'],
    proximityRadiusUnits: ['MILES', 'KILOMETERS'],
    defaultRadius: 20,
    defaultRadiusUnit: 'KILOMETERS'
  },

  // Reporting
  reporting: {
    defaultDateRange: 'LAST_30_DAYS',
    maxRowsPerRequest: 10000,
    defaultMetrics: [
      'impressions',
      'clicks',
      'cost_micros',
      'average_cpc',
      'average_cpm',
      'ctr',
      'conversions',
      'conversions_value',
      'cost_per_conversion'
    ],
    videoMetrics: [
      'video_views',
      'video_quartile_p25_rate',
      'video_quartile_p50_rate',
      'video_quartile_p75_rate',
      'video_quartile_p100_rate',
      'average_cpv'
    ]
  },

  // Cache Settings
  cache: {
    ttl: {
      accountList: 3600, // 1 hour
      campaignMetrics: 900, // 15 minutes
      audienceEstimate: 300, // 5 minutes
      conversionActions: 86400 // 24 hours
    }
  }
};

/**
 * Helper function to get minimum budget for a currency
 */
module.exports.getMinimumBudget = function(currencyCode) {
  return this.campaign.minimumBudgets[currencyCode] || 1;
};

/**
 * Helper function to check if an error is retryable
 */
module.exports.isRetryableError = function(errorCode) {
  return this.errors.retryableCodes.includes(errorCode);
};

/**
 * Helper function to get operation cost
 */
module.exports.getOperationCost = function(operationType) {
  return this.operationCosts[operationType] || 1;
};