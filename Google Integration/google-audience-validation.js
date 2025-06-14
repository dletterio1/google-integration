const Joi = require('joi');

/**
 * Validation schemas for Google Ads audience endpoints
 */

// Create Customer Match Audience Schema
const createCustomerMatchSchema = Joi.object({
  name: Joi.string()
    .trim()
    .min(3)
    .max(255)
    .required()
    .messages({
      'string.min': 'Audience name must be at least 3 characters',
      'string.max': 'Audience name cannot exceed 255 characters',
      'any.required': 'Audience name is required'
    }),
  description: Joi.string()
    .trim()
    .max(1000)
    .optional(),
  customer_ids: Joi.array()
    .items(Joi.string().regex(/^[0-9a-fA-F]{24}$/))
    .min(100)
    .max(1000000)
    .required()
    .messages({
      'array.min': 'At least 100 customers are required for customer match',
      'array.max': 'Cannot exceed 1 million customers per audience',
      'any.required': 'Customer IDs are required'
    }),
  retention_days: Joi.number()
    .integer()
    .min(1)
    .max(540)
    .optional()
    .default(30)
    .messages({
      'number.min': 'Retention days must be at least 1',
      'number.max': 'Retention days cannot exceed 540'
    }),
  upload_key_type: Joi.string()
    .valid('CONTACT_INFO', 'CRM_ID', 'MOBILE_ID')
    .optional()
    .default('CONTACT_INFO')
});

// Create Lookalike Audience Schema
const createLookalikeSchema = Joi.object({
  source_audience_id: Joi.string()
    .required()
    .messages({
      'any.required': 'Source audience ID is required'
    }),
  lookalike_spec: Joi.object({
    country: Joi.string()
      .length(2)
      .uppercase()
      .required()
      .messages({
        'string.length': 'Country must be a 2-letter ISO code',
        'any.required': 'Country is required for lookalike audiences'
      }),
    ratio: Joi.number()
      .min(0.01)
      .max(0.1)
      .optional()
      .default(0.03)
      .messages({
        'number.min': 'Ratio must be at least 0.01 (1%)',
        'number.max': 'Ratio cannot exceed 0.1 (10%)'
      })
  }).required(),
  name: Joi.string()
    .trim()
    .min(3)
    .max(255)
    .optional(),
  description: Joi.string()
    .trim()
    .max(1000)
    .optional()
});

// Update Audience Schema
const updateAudienceSchema = Joi.object({
  add_customers: Joi.array()
    .items(Joi.string().regex(/^[0-9a-fA-F]{24}$/))
    .min(1)
    .max(100000)
    .optional()
    .messages({
      'array.min': 'At least 1 customer must be added',
      'array.max': 'Cannot add more than 100,000 customers at once'
    }),
  remove_customers: Joi.array()
    .items(Joi.string().regex(/^[0-9a-fA-F]{24}$/))
    .min(1)
    .max(100000)
    .optional()
    .messages({
      'array.min': 'At least 1 customer must be removed',
      'array.max': 'Cannot remove more than 100,000 customers at once'
    })
}).or('add_customers', 'remove_customers')
  .messages({
    'object.missing': 'Either add_customers or remove_customers must be provided'
  });

// Create Audience from CSV Upload Schema
const createFromUploadSchema = Joi.object({
  audience_name: Joi.string()
    .trim()
    .min(3)
    .max(255)
    .required()
    .messages({
      'string.min': 'Audience name must be at least 3 characters',
      'string.max': 'Audience name cannot exceed 255 characters',
      'any.required': 'Audience name is required'
    }),
  retention_days: Joi.number()
    .integer()
    .min(1)
    .max(540)
    .optional()
    .default(30),
  filename: Joi.string()
    .optional()
    .when('$hasFile', {
      is: false,
      then: Joi.required()
    }),
  mapping: Joi.object({
    email: Joi.string().optional(),
    phone: Joi.string().optional(),
    first_name: Joi.string().optional(),
    last_name: Joi.string().optional(),
    country: Joi.string().optional(),
    zip_code: Joi.string().optional()
  }).optional()
});

// Get Audiences Query Schema
const getAudiencesQuerySchema = Joi.object({
  page: Joi.number()
    .integer()
    .min(1)
    .optional()
    .default(1),
  limit: Joi.number()
    .integer()
    .min(1)
    .max(100)
    .optional()
    .default(20),
  type: Joi.string()
    .valid('CUSTOMER_MATCH', 'LOOKALIKE', 'REMARKETING', 'CUSTOM')
    .optional(),
  status: Joi.string()
    .valid('OPEN', 'CLOSED')
    .optional(),
  search: Joi.string()
    .trim()
    .optional()
});

// Search Interests Query Schema
const searchInterestsQuerySchema = Joi.object({
  q: Joi.string()
    .trim()
    .min(2)
    .required()
    .messages({
      'string.min': 'Search query must be at least 2 characters',
      'any.required': 'Search query is required'
    }),
  category: Joi.string()
    .optional(),
  limit: Joi.number()
    .integer()
    .min(1)
    .max(50)
    .optional()
    .default(20)
});

// Get Targeting Suggestions Schema
const getTargetingSuggestionsSchema = Joi.object({
  customer_ids: Joi.array()
    .items(Joi.string().regex(/^[0-9a-fA-F]{24}$/))
    .min(10)
    .max(1000)
    .required()
    .messages({
      'array.min': 'At least 10 customers are required for suggestions',
      'array.max': 'Cannot process more than 1,000 customers for suggestions',
      'any.required': 'Customer IDs are required'
    }),
  suggestion_types: Joi.array()
    .items(Joi.string().valid('interests', 'demographics', 'behaviors', 'keywords'))
    .optional()
    .default(['interests', 'demographics'])
});

// Asset Upload Schema (for creative assets)
const uploadAssetSchema = Joi.object({
  asset_type: Joi.string()
    .valid('IMAGE', 'VIDEO')
    .required()
    .messages({
      'any.only': 'Asset type must be IMAGE or VIDEO',
      'any.required': 'Asset type is required'
    }),
  campaign_id: Joi.string()
    .regex(/^[0-9a-fA-F]{24}$/)
    .optional(),
  tags: Joi.array()
    .items(Joi.string().trim())
    .optional(),
  alt_text: Joi.string()
    .trim()
    .max(500)
    .optional()
    .when('asset_type', {
      is: 'IMAGE',
      then: Joi.required()
    })
});

// Link YouTube Video Schema
const linkYouTubeVideoSchema = Joi.object({
  video_url: Joi.string()
    .uri()
    .pattern(/^https:\/\/(www\.)?(youtube\.com\/watch\?v=|youtu\.be\/)/)
    .required()
    .messages({
      'string.pattern.base': 'Must be a valid YouTube video URL',
      'any.required': 'YouTube video URL is required'
    }),
  campaign_id: Joi.string()
    .regex(/^[0-9a-fA-F]{24}$/)
    .required()
    .messages({
      'any.required': 'Campaign ID is required'
    }),
  ad_group_id: Joi.string()
    .regex(/^[0-9a-fA-F]{24}$/)
    .optional()
});

module.exports = {
  createCustomerMatchSchema,
  createLookalikeSchema,
  updateAudienceSchema,
  createFromUploadSchema,
  getAudiencesQuerySchema,
  searchInterestsQuerySchema,
  getTargetingSuggestionsSchema,
  uploadAssetSchema,
  linkYouTubeVideoSchema
};