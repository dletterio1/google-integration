const Joi = require('joi');

/**
 * Validation schemas for Google Ads campaign endpoints
 */

// Common schemas
const budgetSchema = Joi.object({
  amount: Joi.number()
    .positive()
    .required()
    .messages({
      'number.base': 'Budget amount must be a number',
      'number.positive': 'Budget amount must be positive',
      'any.required': 'Budget amount is required'
    }),
  currency: Joi.string()
    .length(3)
    .uppercase()
    .optional()
    .default('COP'),
  type: Joi.string()
    .valid('daily', 'lifetime')
    .required()
    .messages({
      'any.only': 'Budget type must be either daily or lifetime'
    })
});

const scheduleSchema = Joi.object({
  startDate: Joi.date()
    .iso()
    .required()
    .messages({
      'date.base': 'Start date must be a valid date',
      'any.required': 'Start date is required'
    }),
  endDate: Joi.date()
    .iso()
    .greater(Joi.ref('startDate'))
    .required()
    .messages({
      'date.base': 'End date must be a valid date',
      'date.greater': 'End date must be after start date',
      'any.required': 'End date is required'
    }),
  timezone: Joi.string()
    .optional()
    .default('America/Bogota')
});

const locationSchema = Joi.object({
  key: Joi.string()
    .required()
    .messages({
      'any.required': 'Location key is required'
    }),
  name: Joi.string()
    .required()
    .messages({
      'any.required': 'Location name is required'
    }),
  type: Joi.string()
    .valid('country', 'region', 'city', 'postal_code')
    .required()
    .messages({
      'any.only': 'Location type must be country, region, city, or postal_code'
    }),
  radius: Joi.number()
    .positive()
    .optional(),
  distance_unit: Joi.string()
    .valid('MILES', 'KILOMETERS')
    .optional()
    .default('KILOMETERS')
});

const audienceSchema = Joi.object({
  locations: Joi.array()
    .items(locationSchema)
    .min(1)
    .required()
    .messages({
      'array.min': 'At least one location is required'
    }),
  age_min: Joi.number()
    .integer()
    .min(18)
    .optional()
    .default(18),
  age_max: Joi.number()
    .integer()
    .max(65)
    .optional()
    .default(65)
    .when('age_min', {
      is: Joi.exist(),
      then: Joi.number().greater(Joi.ref('age_min'))
    }),
  genders: Joi.array()
    .items(Joi.number().valid(0, 1, 2))
    .optional()
    .default([0]), // 0=all, 1=male, 2=female
  languages: Joi.array()
    .items(Joi.string())
    .optional(),
  interests: Joi.array()
    .items(Joi.object({
      id: Joi.string().required(),
      name: Joi.string().required()
    }))
    .optional(),
  custom_audiences: Joi.array()
    .items(Joi.string().regex(/^[0-9]+$/))
    .optional(),
  excluded_custom_audiences: Joi.array()
    .items(Joi.string().regex(/^[0-9]+$/))
    .optional()
});

const attributionSchema = Joi.object({
  utm_source: Joi.string()
    .optional()
    .default('google'),
  utm_medium: Joi.string()
    .optional(),
  utm_campaign: Joi.string()
    .regex(/^[a-z0-9-_]+$/)
    .optional()
    .messages({
      'string.pattern.base': 'UTM campaign must contain only lowercase letters, numbers, hyphens, and underscores'
    }),
  utm_content: Joi.string()
    .optional(),
  utm_term: Joi.string()
    .optional()
});

// Create Display Campaign Schema
const createDisplayCampaignSchema = Joi.object({
  _event: Joi.string()
    .regex(/^[0-9a-fA-F]{24}$/)
    .required()
    .messages({
      'string.pattern.base': 'Event ID must be a valid MongoDB ObjectId',
      'any.required': 'Event ID is required'
    }),
  name: Joi.string()
    .trim()
    .min(3)
    .max(255)
    .required()
    .messages({
      'string.min': 'Campaign name must be at least 3 characters',
      'string.max': 'Campaign name cannot exceed 255 characters',
      'any.required': 'Campaign name is required'
    }),
  objective: Joi.string()
    .valid('OUTCOME_TRAFFIC', 'OUTCOME_AWARENESS', 'OUTCOME_ENGAGEMENT', 'OUTCOME_LEADS', 'OUTCOME_SALES')
    .optional()
    .default('OUTCOME_TRAFFIC'),
  budget: budgetSchema.required(),
  schedule: scheduleSchema.required(),
  audience: audienceSchema.required(),
  biddingStrategy: Joi.object({
    type: Joi.string()
      .valid('MAXIMIZE_CLICKS', 'TARGET_CPA', 'TARGET_ROAS', 'MAXIMIZE_CONVERSIONS', 'MANUAL_CPC')
      .required()
      .messages({
        'any.only': 'Invalid bidding strategy type'
      }),
    targetCpa: Joi.when('type', {
      is: Joi.valid('TARGET_CPA', 'MAXIMIZE_CONVERSIONS'),
      then: Joi.number().positive().required(),
      otherwise: Joi.forbidden()
    }),
    targetRoas: Joi.when('type', {
      is: 'TARGET_ROAS',
      then: Joi.number().positive().required(),
      otherwise: Joi.forbidden()
    }),
    defaultBid: Joi.when('type', {
      is: 'MANUAL_CPC',
      then: Joi.number().positive().required(),
      otherwise: Joi.number().positive().optional()
    }),
    targetSpend: Joi.when('type', {
      is: 'MAXIMIZE_CLICKS',
      then: Joi.number().positive().optional(),
      otherwise: Joi.forbidden()
    }),
    cpcBidCeiling: Joi.number()
      .positive()
      .optional()
  }).required(),
  attribution: attributionSchema.optional(),
  subType: Joi.string()
    .valid('DISPLAY_STANDARD', 'DISPLAY_SMART_CAMPAIGN')
    .optional()
    .default('DISPLAY_STANDARD')
});

// Create YouTube Campaign Schema
const createYouTubeCampaignSchema = Joi.object({
  _event: Joi.string()
    .regex(/^[0-9a-fA-F]{24}$/)
    .required()
    .messages({
      'string.pattern.base': 'Event ID must be a valid MongoDB ObjectId',
      'any.required': 'Event ID is required'
    }),
  name: Joi.string()
    .trim()
    .min(3)
    .max(255)
    .required()
    .messages({
      'string.min': 'Campaign name must be at least 3 characters',
      'string.max': 'Campaign name cannot exceed 255 characters',
      'any.required': 'Campaign name is required'
    }),
  objective: Joi.string()
    .valid('OUTCOME_AWARENESS', 'OUTCOME_TRAFFIC', 'OUTCOME_ENGAGEMENT', 'OUTCOME_LEADS', 'OUTCOME_SALES')
    .optional()
    .default('OUTCOME_AWARENESS'),
  budget: budgetSchema.required(),
  schedule: scheduleSchema.required(),
  audience: audienceSchema.extend({
    youtube_channels: Joi.array()
      .items(Joi.string())
      .optional(),
    youtube_videos: Joi.array()
      .items(Joi.string())
      .optional()
  }).required(),
  biddingStrategy: Joi.object({
    type: Joi.string()
      .valid('TARGET_CPA', 'TARGET_CPV', 'MAXIMIZE_CONVERSIONS')
      .required()
      .messages({
        'any.only': 'Invalid bidding strategy for YouTube campaigns'
      }),
    targetCpa: Joi.when('type', {
      is: Joi.valid('TARGET_CPA', 'MAXIMIZE_CONVERSIONS'),
      then: Joi.number().positive().required(),
      otherwise: Joi.forbidden()
    }),
    targetCpv: Joi.when('type', {
      is: 'TARGET_CPV',
      then: Joi.number().positive().required(),
      otherwise: Joi.number().positive().optional()
    })
  }).required(),
  videoGoal: Joi.string()
    .valid('VIDEO_ACTION', 'VIDEO_REACH', 'VIDEO_AWARENESS')
    .optional()
    .default('VIDEO_ACTION'),
  videoAdFormat: Joi.string()
    .valid('in_stream', 'discovery', 'bumper', 'non_skippable')
    .optional()
    .default('in_stream'),
  brandSafety: Joi.string()
    .valid('EXPANDED_INVENTORY', 'STANDARD_INVENTORY', 'LIMITED_INVENTORY')
    .optional()
    .default('EXPANDED_INVENTORY'),
  includeGoogleTv: Joi.boolean()
    .optional()
    .default(false),
  attribution: attributionSchema.optional()
});

// Update Campaign Schema
const updateCampaignSchema = Joi.object({
  name: Joi.string()
    .trim()
    .min(3)
    .max(255)
    .optional(),
  budget: Joi.object({
    amount: Joi.number()
      .positive()
      .required(),
    type: Joi.string()
      .valid('daily', 'lifetime')
      .optional()
  }).optional(),
  schedule: Joi.object({
    endDate: Joi.date()
      .iso()
      .optional()
  }).optional(),
  audience: Joi.object({
    locations: Joi.array()
      .items(locationSchema)
      .optional(),
    age_min: Joi.number()
      .integer()
      .min(18)
      .optional(),
    age_max: Joi.number()
      .integer()
      .max(65)
      .optional()
  }).optional()
}).min(1).messages({
  'object.min': 'At least one field must be provided for update'
});

// Update Campaign Status Schema
const updateCampaignStatusSchema = Joi.object({
  status: Joi.string()
    .valid('active', 'paused', 'completed')
    .required()
    .messages({
      'any.only': 'Status must be active, paused, or completed',
      'any.required': 'Status is required'
    }),
  reason: Joi.string()
    .optional()
    .when('status', {
      is: 'paused',
      then: Joi.string().optional()
    })
});

// Sync Metrics Schema
const syncMetricsSchema = Joi.object({
  dateRange: Joi.object({
    startDate: Joi.date()
      .iso()
      .required(),
    endDate: Joi.date()
      .iso()
      .greater(Joi.ref('startDate'))
      .required()
  }).optional()
});

// Bulk Sync Schema
const bulkSyncMetricsSchema = Joi.object({
  campaignIds: Joi.array()
    .items(Joi.string().regex(/^[0-9a-fA-F]{24}$/))
    .optional(),
  dateRange: Joi.object({
    startDate: Joi.date()
      .iso()
      .required(),
    endDate: Joi.date()
      .iso()
      .greater(Joi.ref('startDate'))
      .required()
  }).optional()
});

// Switch Account Schema (for auth)
const switchAccountSchema = Joi.object({
  customerId: Joi.string()
    .regex(/^\d{10}$/)
    .required()
    .messages({
      'string.pattern.base': 'Customer ID must be exactly 10 digits',
      'any.required': 'Customer ID is required'
    })
});

module.exports = {
  createDisplayCampaignSchema,
  createYouTubeCampaignSchema,
  updateCampaignSchema,
  updateCampaignStatusSchema,
  syncMetricsSchema,
  bulkSyncMetricsSchema,
  switchAccountSchema
};