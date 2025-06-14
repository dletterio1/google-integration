const googleAuthService = require('../../../services/google-ads/google-auth.service');
const { ResponseFormatter } = require('../../../utils/responseFormatter');
const { UserFriendlyError } = require('../../../utils/errors');
const logger = require('../../../utils/logger');

class GoogleAuthController {
  /**
   * Initiate Google Ads OAuth connection
   * @route GET /api/v1/adbuilder/auth/google/connect
   */
  async initiateConnection(req, res) {
    try {
      const { organizationId } = req.auth;
      const userId = req.auth.userId;

      // Validate organization has permission
      if (!req.organization.features?.adBuilder) {
        throw new UserFriendlyError(
          'AdBuilder feature is not enabled for your organization',
          'FEATURE_NOT_ENABLED'
        );
      }

      // Generate OAuth URL
      const { authUrl, state } = await googleAuthService.initiateOAuthFlow(
        organizationId,
        userId
      );

      // Log initiation
      logger.info('Google Ads connection initiated', {
        organizationId,
        userId,
        state: state.substring(0, 8) + '...'
      });

      return ResponseFormatter.success(res, {
        authUrl,
        state
      }, 'Google Ads connection initiated. Redirecting to Google...');
    } catch (error) {
      logger.error('Failed to initiate Google Ads connection', error);
      return ResponseFormatter.error(res, error);
    }
  }

  /**
   * Handle OAuth callback from Google
   * @route GET /api/v1/adbuilder/auth/google/callback
   * Note: This is a PUBLIC endpoint that validates state internally
   */
  async handleCallback(req, res) {
    try {
      const { code, state, error: oauthError } = req.query;

      // Check for OAuth errors from Google
      if (oauthError) {
        logger.error('Google OAuth error', { error: oauthError });
        
        // Redirect to frontend with error
        const errorUrl = new URL(process.env.FRONTEND_URL + '/portal/adbuilder/settings');
        errorUrl.searchParams.set('error', 'google_connection_failed');
        errorUrl.searchParams.set('message', oauthError === 'access_denied' 
          ? 'Permission denied. Please grant all requested permissions.'
          : 'Failed to connect Google Ads account.');
        
        return res.redirect(errorUrl.toString());
      }

      // Validate required parameters
      if (!code || !state) {
        const errorUrl = new URL(process.env.FRONTEND_URL + '/portal/adbuilder/settings');
        errorUrl.searchParams.set('error', 'invalid_callback');
        errorUrl.searchParams.set('message', 'Missing required parameters');
        
        return res.redirect(errorUrl.toString());
      }

      // Handle the OAuth callback
      const connection = await googleAuthService.handleOAuthCallback(code, state);

      // Redirect to frontend with success
      const successUrl = new URL(process.env.FRONTEND_URL + '/portal/adbuilder/settings');
      successUrl.searchParams.set('success', 'google_connected');
      successUrl.searchParams.set('accountName', connection.customerName);
      successUrl.searchParams.set('accountId', connection.customerId);
      
      logger.info('Google Ads connection successful', {
        organizationId: connection._organization,
        customerId: connection.customerId
      });

      return res.redirect(successUrl.toString());
    } catch (error) {
      logger.error('Google OAuth callback error', error);

      // Redirect to frontend with error
      const errorUrl = new URL(process.env.FRONTEND_URL + '/portal/adbuilder/settings');
      errorUrl.searchParams.set('error', 'connection_failed');
      
      if (error instanceof UserFriendlyError) {
        errorUrl.searchParams.set('message', error.message);
        errorUrl.searchParams.set('code', error.code);
      } else {
        errorUrl.searchParams.set('message', 'Failed to connect Google Ads account. Please try again.');
      }

      return res.redirect(errorUrl.toString());
    }
  }

  /**
   * Get Google Ads connection status
   * @route GET /api/v1/adbuilder/auth/google/status
   */
  async getConnectionStatus(req, res) {
    try {
      const { organizationId } = req.auth;

      const status = await googleAuthService.getConnectionStatus(organizationId);

      return ResponseFormatter.success(res, status, 
        status.connected 
          ? 'Google Ads connection is active' 
          : 'No Google Ads connection found'
      );
    } catch (error) {
      logger.error('Failed to get connection status', error);
      return ResponseFormatter.error(res, error);
    }
  }

  /**
   * Get accessible Google Ads accounts
   * @route GET /api/v1/adbuilder/auth/google/accounts
   */
  async getAccessibleAccounts(req, res) {
    try {
      const { organizationId } = req.auth;

      const accounts = await googleAuthService.getAccessibleAccounts(organizationId);

      // Format accounts for frontend
      const formattedAccounts = accounts.map(account => ({
        id: account.customerId,
        name: account.descriptiveName,
        currency: account.currencyCode,
        timezone: account.timeZone,
        status: account.accountStatus,
        isTest: account.isTestAccount,
        isManager: account.isManager,
        canManageCampaigns: account.canManageCampaigns
      }));

      return ResponseFormatter.success(res, {
        accounts: formattedAccounts,
        count: formattedAccounts.length
      }, 'Google Ads accounts retrieved successfully');
    } catch (error) {
      logger.error('Failed to get accessible accounts', error);
      return ResponseFormatter.error(res, error);
    }
  }

  /**
   * Switch active Google Ads account
   * @route POST /api/v1/adbuilder/auth/google/switch-account
   */
  async switchAccount(req, res) {
    try {
      const { organizationId, userId } = req.auth;
      const { customerId } = req.body;

      if (!customerId) {
        throw new UserFriendlyError(
          'Customer ID is required',
          'MISSING_CUSTOMER_ID'
        );
      }

      // Get current connection
      const connection = await googleAuthService.getConnection(organizationId);
      
      if (!connection) {
        throw new UserFriendlyError(
          'No active Google Ads connection found',
          'NO_CONNECTION'
        );
      }

      // Validate customer ID exists in accessible accounts
      const account = connection.accessibleCustomers.find(
        acc => acc.customerId === customerId
      );

      if (!account) {
        throw new UserFriendlyError(
          'This account is not accessible with your current connection',
          'ACCOUNT_NOT_ACCESSIBLE'
        );
      }

      if (!account.canManageCampaigns) {
        throw new UserFriendlyError(
          'This account cannot be used to manage campaigns',
          'ACCOUNT_CANNOT_MANAGE'
        );
      }

      // Update primary customer
      connection.customerId = account.customerId;
      connection.customerName = account.descriptiveName;
      connection.currencyCode = account.currencyCode;
      connection.timeZone = account.timeZone;
      connection._updated_by = userId;
      await connection.save();

      logger.info('Google Ads account switched', {
        organizationId,
        previousCustomerId: connection.customerId,
        newCustomerId: customerId
      });

      return ResponseFormatter.success(res, {
        customerId: account.customerId,
        customerName: account.descriptiveName,
        currency: account.currencyCode,
        timezone: account.timeZone
      }, 'Google Ads account switched successfully');
    } catch (error) {
      logger.error('Failed to switch account', error);
      return ResponseFormatter.error(res, error);
    }
  }

  /**
   * Disconnect Google Ads
   * @route DELETE /api/v1/adbuilder/auth/google/disconnect
   */
  async disconnect(req, res) {
    try {
      const { organizationId, userId } = req.auth;

      await googleAuthService.disconnect(organizationId, userId);

      return ResponseFormatter.success(res, null, 'Google Ads disconnected successfully');
    } catch (error) {
      logger.error('Failed to disconnect Google Ads', error);
      return ResponseFormatter.error(res, error);
    }
  }

  /**
   * Refresh Google Ads connection
   * @route POST /api/v1/adbuilder/auth/google/refresh
   */
  async refreshConnection(req, res) {
    try {
      const { organizationId } = req.auth;

      const connection = await googleAuthService.getConnection(organizationId);
      
      if (!connection) {
        throw new UserFriendlyError(
          'No active Google Ads connection found',
          'NO_CONNECTION'
        );
      }

      // Force token refresh
      await googleAuthService.refreshAccessToken(connection);

      // Re-fetch accounts
      const accounts = await googleAuthService.getAccessibleAccounts(organizationId);

      return ResponseFormatter.success(res, {
        refreshed: true,
        accountCount: accounts.length,
        tokenExpiresAt: connection.tokenExpiresAt
      }, 'Google Ads connection refreshed successfully');
    } catch (error) {
      logger.error('Failed to refresh connection', error);
      return ResponseFormatter.error(res, error);
    }
  }

  /**
   * Test Google Ads API connection
   * @route POST /api/v1/adbuilder/auth/google/test
   */
  async testConnection(req, res) {
    try {
      const { organizationId } = req.auth;

      // Get authenticated client
      const client = await googleAuthService.getAuthenticatedClient(organizationId);
      
      // Get connection details
      const connection = await googleAuthService.getConnection(organizationId);

      // Try a simple API call
      const customer = client.Customer({
        customer_id: connection.customerId,
        refresh_token: client.config.refresh_token,
        login_customer_id: client.config.login_customer_id
      });

      const query = `
        SELECT 
          customer.id,
          customer.descriptive_name
        FROM customer
        LIMIT 1
      `;

      const [result] = await customer.query(query);

      if (!result) {
        throw new Error('No customer data returned');
      }

      return ResponseFormatter.success(res, {
        connected: true,
        customerId: result.customer.id,
        customerName: result.customer.descriptive_name,
        apiVersion: client.config.api_version || 'v18',
        quotaUsed: connection.dailyApiOperations,
        quotaResetAt: connection.apiQuotaResetAt
      }, 'Google Ads API connection is working correctly');
    } catch (error) {
      logger.error('Google Ads API test failed', error);
      
      return ResponseFormatter.error(res, 
        new UserFriendlyError(
          'Google Ads API connection test failed. Please check your connection.',
          'API_TEST_FAILED',
          { error: error.message }
        )
      );
    }
  }
}

module.exports = new GoogleAuthController();