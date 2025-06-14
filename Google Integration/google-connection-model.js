const mongoose = require('mongoose');
const { Schema } = mongoose;

const GoogleConnectionSchema = new Schema({
  // Core References (Following your pattern)
  _organization: {
    type: Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    index: true
  },
  _connected_by: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  _updated_by: {
    type: Schema.Types.ObjectId,
    ref: 'User'
  },

  // Google Identity
  googleUserId: {
    type: String,
    required: true,
    index: true
  },
  googleUserEmail: {
    type: String,
    required: true,
    lowercase: true,
    trim: true
  },

  // Customer Hierarchy (Critical for Google Ads)
  managerCustomerId: {
    type: String,
    trim: true,
    index: true,
    validate: {
      validator: function(v) {
        // Google customer IDs are 10 digits, often formatted as XXX-XXX-XXXX
        return !v || /^\d{10}$/.test(v.replace(/-/g, ''));
      },
      message: 'Invalid Google Ads customer ID format'
    }
  },
  customerId: {
    type: String,
    required: true,
    index: true,
    validate: {
      validator: function(v) {
        return /^\d{10}$/.test(v.replace(/-/g, ''));
      },
      message: 'Invalid Google Ads customer ID format'
    }
  },
  customerName: {
    type: String,
    trim: true
  },
  currencyCode: {
    type: String,
    uppercase: true,
    required: true,
    validate: {
      validator: function(v) {
        // ISO 4217 currency codes
        return /^[A-Z]{3}$/.test(v);
      },
      message: 'Invalid currency code format'
    }
  },
  timeZone: {
    type: String,
    required: true
  },

  // Encrypted OAuth Tokens (Following your AES-256-GCM pattern)
  accessToken: {
    type: String,
    required: true
    // Will be encrypted before storage
  },
  refreshToken: {
    type: String,
    required: true
    // Will be encrypted before storage
  },
  tokenExpiresAt: {
    type: Date,
    required: true,
    index: true
  },

  // Additional Accessible Customers (for agencies/MCCs)
  accessibleCustomers: [{
    customerId: {
      type: String,
      required: true
    },
    descriptiveName: {
      type: String,
      trim: true
    },
    currencyCode: {
      type: String,
      uppercase: true
    },
    timeZone: String,
    canManageCampaigns: {
      type: Boolean,
      default: true
    },
    isTestAccount: {
      type: Boolean,
      default: false
    },
    isManager: {
      type: Boolean,
      default: false
    },
    accountStatus: {
      type: String,
      enum: ['ENABLED', 'SUSPENDED', 'REMOVED', 'CLOSED'],
      default: 'ENABLED'
    }
  }],

  // API Access Control (For rate limiting)
  dailyApiOperations: {
    type: Number,
    default: 0,
    min: 0
  },
  lastApiOperationAt: {
    type: Date
  },
  apiQuotaResetAt: {
    type: Date,
    default: function() {
      // Reset at midnight PST (Google's timezone)
      const now = new Date();
      const pst = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
      pst.setDate(pst.getDate() + 1);
      pst.setHours(0, 0, 0, 0);
      return pst;
    }
  },

  // Permissions & Compliance
  permissions: [{
    type: String
    // Stores OAuth scopes granted
  }],
  hasAcceptedTos: {
    type: Boolean,
    required: true,
    default: false
  },
  tosAcceptedAt: {
    type: Date
  },

  // Connection Status
  status: {
    type: String,
    enum: ['active', 'suspended', 'expired', 'revoked', 'error'],
    default: 'active',
    index: true
  },
  statusReason: String,
  lastError: {
    message: String,
    code: String,
    timestamp: Date
  },

  // Sync Tracking
  lastSyncAt: {
    type: Date
  },
  syncFailures: {
    type: Number,
    default: 0
  },

  // Timestamps
  connectedAt: {
    type: Date,
    required: true,
    default: Date.now
  }
}, {
  timestamps: true // Adds createdAt and updatedAt
});

// Indexes for common queries
GoogleConnectionSchema.index({ _organization: 1, status: 1 });
GoogleConnectionSchema.index({ _organization: 1, customerId: 1 });
GoogleConnectionSchema.index({ tokenExpiresAt: 1, status: 1 }); // For finding expiring tokens

// Virtual for checking if token needs refresh
GoogleConnectionSchema.virtual('needsTokenRefresh').get(function() {
  if (!this.tokenExpiresAt) return true;
  // Refresh if expires in less than 5 minutes
  const fiveMinutesFromNow = new Date(Date.now() + 5 * 60 * 1000);
  return this.tokenExpiresAt <= fiveMinutesFromNow;
});

// Virtual for checking if quota reset is needed
GoogleConnectionSchema.virtual('needsQuotaReset').get(function() {
  return new Date() >= this.apiQuotaResetAt;
});

// Method to increment API operations
GoogleConnectionSchema.methods.incrementApiOperations = async function(operations = 1) {
  // Check if we need to reset daily quota
  if (this.needsQuotaReset) {
    this.dailyApiOperations = 0;
    this.apiQuotaResetAt = new Date();
    this.apiQuotaResetAt.setDate(this.apiQuotaResetAt.getDate() + 1);
    this.apiQuotaResetAt.setHours(0, 0, 0, 0);
  }
  
  this.dailyApiOperations += operations;
  this.lastApiOperationAt = new Date();
  return this.save();
};

// Method to find primary customer account
GoogleConnectionSchema.methods.getPrimaryCustomer = function() {
  if (this.accessibleCustomers && this.accessibleCustomers.length > 0) {
    // Find the matching customer or first non-test, enabled account
    return this.accessibleCustomers.find(c => c.customerId === this.customerId) ||
           this.accessibleCustomers.find(c => !c.isTestAccount && c.accountStatus === 'ENABLED') ||
           this.accessibleCustomers[0];
  }
  return {
    customerId: this.customerId,
    descriptiveName: this.customerName,
    currencyCode: this.currencyCode,
    timeZone: this.timeZone,
    canManageCampaigns: true
  };
};

// Static method to find active connection for organization
GoogleConnectionSchema.statics.findActiveConnection = async function(organizationId) {
  return this.findOne({
    _organization: organizationId,
    status: 'active'
  });
};

// Pre-save middleware for token expiry calculation
GoogleConnectionSchema.pre('save', function(next) {
  // If access token is being updated, ensure expiry is set
  if (this.isModified('accessToken') && !this.isModified('tokenExpiresAt')) {
    // Google tokens typically expire in 1 hour
    this.tokenExpiresAt = new Date(Date.now() + 3600 * 1000);
  }
  
  // Update tosAcceptedAt when accepting ToS
  if (this.isModified('hasAcceptedTos') && this.hasAcceptedTos && !this.tosAcceptedAt) {
    this.tosAcceptedAt = new Date();
  }
  
  next();
});

// Ensure only one active connection per organization
GoogleConnectionSchema.pre('save', async function(next) {
  if (this.isNew && this.status === 'active') {
    // Deactivate any existing active connections for this organization
    await this.constructor.updateMany(
      {
        _organization: this._organization,
        _id: { $ne: this._id },
        status: 'active'
      },
      {
        $set: {
          status: 'revoked',
          statusReason: 'New connection established',
          _updated_by: this._connected_by
        }
      }
    );
  }
  next();
});

// Hide sensitive fields in JSON output
GoogleConnectionSchema.set('toJSON', {
  transform: function(doc, ret) {
    delete ret.accessToken;
    delete ret.refreshToken;
    return ret;
  }
});

// Add audit trail integration
GoogleConnectionSchema.post('save', async function(doc) {
  // Only log significant changes
  if (this.wasNew || this.modifiedPaths().includes('status')) {
    const AuditLog = mongoose.model('AuditLog');
    await AuditLog.create({
      _organization: doc._organization,
      _user: doc._updated_by || doc._connected_by,
      action: this.wasNew ? 'google_connection_created' : 'google_connection_updated',
      resource: 'GoogleConnection',
      resourceId: doc._id,
      metadata: {
        customerId: doc.customerId,
        status: doc.status,
        previousStatus: this.wasNew ? null : this._previousStatus
      }
    });
  }
});

// Track previous status for audit logging
GoogleConnectionSchema.pre('save', function(next) {
  if (this.isModified('status') && !this.isNew) {
    this._previousStatus = this._original?.status;
  }
  next();
});

module.exports = mongoose.model('GoogleConnection', GoogleConnectionSchema);