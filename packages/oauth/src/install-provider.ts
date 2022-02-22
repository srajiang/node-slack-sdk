import { IncomingMessage, ServerResponse } from 'http';
import { URLSearchParams, URL } from 'url';

import { WebAPICallResult, WebClient, WebClientOptions } from '@slack/web-api';

import { AuthorizeResult } from './authorize-result';
import { CallbackOptions, defaultCallbackFailure, defaultCallbackSuccess } from './callback-options';
import {
  InstallerInitializationError,
  UnknownError,
  MissingStateError,
  MissingCodeError,
  GenerateInstallUrlError,
  AuthorizationError,
} from './errors';
import { Installation, OrgInstallation } from './installation';
import { InstallationQuery } from './installation-query';
import { InstallURLOptions } from './install-url-options';
import { InstallProviderOptions } from './install-provider-options';
import { Logger, LogLevel, getLogger } from './logger';
import { ClearStateStore, StateStore } from './state-stores';
import { InstallationStore, MemoryInstallationStore } from './stores';

/**
 * InstallProvider Class.
 * @param clientId - Your apps client ID
 * @param clientSecret - Your apps client Secret
 * @param stateSecret - Used to sign and verify the generated state when using the built-in `stateStore`
 * @param stateStore - Replacement function for the built-in `stateStore`
 * @param stateVerification - Pass in false to disable state parameter verification
 * @param installationStore - Interface to store and retrieve installation data from the database
 * @param authVersion - Can be either `v1` or `v2`. Determines which slack Oauth URL and method to use
 * @param logger - Pass in your own Logger if you don't want to use the built-in one
 * @param logLevel - Pass in the log level you want (ERROR, WARN, INFO, DEBUG). Default is INFO
 */
export class InstallProvider {
  public stateStore?: StateStore;

  public installationStore: InstallationStore;

  private clientId: string;

  private clientSecret: string;

  private authVersion: string;

  private logger: Logger;

  private clientOptions: WebClientOptions;

  private authorizationUrl: string;

  private stateVerification: boolean;

  public constructor({
    clientId,
    clientSecret,
    stateSecret = undefined,
    stateStore = undefined,
    stateVerification = true,
    installationStore = new MemoryInstallationStore(),
    authVersion = 'v2',
    logger = undefined,
    logLevel = undefined,
    clientOptions = {},
    authorizationUrl = 'https://slack.com/oauth/v2/authorize',
  }: InstallProviderOptions) {
    if (clientId === undefined || clientSecret === undefined) {
      throw new InstallerInitializationError('You must provide a valid clientId and clientSecret');
    }

    // Setup the logger
    if (typeof logger !== 'undefined') {
      this.logger = logger;
      if (typeof logLevel !== 'undefined') {
        this.logger.debug('The logLevel given to OAuth was ignored as you also gave logger');
      }
    } else {
      this.logger = getLogger('OAuth:InstallProvider', logLevel ?? LogLevel.INFO, logger);
    }
    this.stateVerification = stateVerification;
    if (!stateVerification) {
      this.logger.warn("You've set InstallProvider#stateVerification to false. This flag is intended to enable org-wide app installations from admin pages. If this isn't your scenario, we recommend setting stateVerification to true and starting your OAuth flow from the provided `/slack/install` or your own starting endpoint.");
    }
    // Setup stateStore
    if (stateStore !== undefined) {
      this.stateStore = stateStore;
    } else if (this.stateVerification) {
      // if state verification is disabled, state store is not necessary
      if (stateSecret !== undefined) {
        this.stateStore = new ClearStateStore(stateSecret);
      } else {
        throw new InstallerInitializationError('To use the built-in state store you must provide a State Secret');
      }
    }

    this.installationStore = installationStore;
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.handleCallback = this.handleCallback.bind(this);
    this.authorize = this.authorize.bind(this);
    this.authVersion = authVersion;

    this.authorizationUrl = authorizationUrl;
    if (authorizationUrl !== 'https://slack.com/oauth/v2/authorize' && authVersion === 'v1') {
      this.logger.info('You provided both an authorizationUrl and an authVersion! The authVersion will be ignored in favor of the authorizationUrl.');
    } else if (authVersion === 'v1') {
      this.authorizationUrl = 'https://slack.com/oauth/authorize';
    }

    this.clientOptions = {
      logger,
      logLevel: this.logger.getLevel(),
      ...clientOptions,
    };
  }

  /**
   * Fetches data from the installationStore
   */
  public async authorize(source: InstallationQuery<boolean>): Promise<AuthorizeResult> {
    try {
      // Note that `queryResult` may unexpectedly include null values for some properties.
      // For example, MongoDB can often save properties as null for some reasons.
      // Inside this method, we should alwayss check if a value is either undefined or null.
      let queryResult;
      if (source.isEnterpriseInstall) {
        queryResult = await this.installationStore.fetchInstallation(source as InstallationQuery<true>, this.logger);
      } else {
        queryResult = await this.installationStore.fetchInstallation(source as InstallationQuery<false>, this.logger);
      }

      if (queryResult === undefined || queryResult === null) {
        throw new Error('Failed fetching data from the Installation Store');
      }

      const authResult: AuthorizeResult = {};

      if (queryResult.user) {
        authResult.userToken = queryResult.user.token;
      }

      if (queryResult.team?.id) {
        authResult.teamId = queryResult.team.id;
      } else if (source?.teamId) {
        /**
         * Since queryResult is a org installation, it won't have team.id.
         * If one was passed in via source, we should add it to the authResult.
         */
        authResult.teamId = source.teamId;
      }

      if (queryResult?.enterprise?.id || source?.enterpriseId) {
        authResult.enterpriseId = queryResult?.enterprise?.id || source?.enterpriseId;
      }

      if (queryResult.bot) {
        authResult.botToken = queryResult.bot.token;
        authResult.botId = queryResult.bot.id;
        authResult.botUserId = queryResult.bot.userId;

        // Token Rotation Enabled (Bot Token)
        if (queryResult.bot.refreshToken) {
          authResult.botRefreshToken = queryResult.bot.refreshToken;
          authResult.botTokenExpiresAt = queryResult.bot.expiresAt; // utc, seconds
        }
      }

      // Token Rotation Enabled (User Token)
      if (queryResult.user?.refreshToken) {
        authResult.userRefreshToken = queryResult.user.refreshToken;
        authResult.userTokenExpiresAt = queryResult.user.expiresAt; // utc, seconds
      }

      /*
      * Token Rotation (Expiry Check + Refresh)
      * The presence of `(bot|user)TokenExpiresAt` indicates having opted into token rotation.
      * If the token has expired, or will expire within 2 hours, the token is refreshed and
      * the `authResult` and `Installation` are updated with the new values.
      */
      if (authResult.botRefreshToken || authResult.userRefreshToken) {
        const currentUTCSec = Math.floor(Date.now() / 1000); // seconds
        const tokensToRefresh: string[] = detectExpiredOrExpiringTokens(authResult, currentUTCSec);

        if (tokensToRefresh.length > 0) {
          const installationUpdates: any = { ...queryResult }; // TODO :: TS
          const refreshResponses = await this.refreshExpiringTokens(tokensToRefresh);

          // TODO: perhaps this for..of loop could introduce an async delay due to await'ing once for each refreshResp?
          // Could we rewrite to be more performant and not trigger the eslint warning? Perhaps a concurrent async
          // map/reduce? But will the return value be the same? Does order of this array matter?
          // eslint-disable-next-line no-restricted-syntax
          for (const refreshResp of refreshResponses) {
            const tokenType = refreshResp.token_type;

            // Update Authorization
            if (tokenType === 'bot') {
              authResult.botToken = refreshResp.access_token;
              authResult.botRefreshToken = refreshResp.refresh_token;
              authResult.botTokenExpiresAt = currentUTCSec + refreshResp.expires_in;
            }

            if (tokenType === 'user') {
              authResult.userToken = refreshResp.access_token;
              authResult.userRefreshToken = refreshResp.refresh_token;
              authResult.userTokenExpiresAt = currentUTCSec + refreshResp.expires_in;
            }

            // Update Installation
            installationUpdates[tokenType].token = refreshResp.access_token;
            installationUpdates[tokenType].refreshToken = refreshResp.refresh_token;
            installationUpdates[tokenType].expiresAt = currentUTCSec + refreshResp.expires_in;

            const updatedInstallation = {
              ...installationUpdates,
              [tokenType]: { ...queryResult[tokenType], ...installationUpdates[tokenType] },
            };

            // TODO: related to the above TODO comment as well
            // eslint-disable-next-line no-await-in-loop
            await this.installationStore.storeInstallation(updatedInstallation);
          }
        }
      }

      return authResult;
    } catch (error: any) {
      throw new AuthorizationError(error.message);
    }
  }

  /**
   * refreshExpiringTokens refreshes expired access tokens using the `oauth.v2.access` endpoint.
   *
   * The return value is an Array of Promises made up of the resolution of each token refresh attempt.
   */
  private async refreshExpiringTokens(tokensToRefresh: string[]): Promise<OAuthV2TokenRefreshResponse[]> {
    const client = new WebClient(undefined, this.clientOptions);

    const refreshPromises = tokensToRefresh.map(async (refreshToken) => await client.oauth.v2.access({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }).catch((e) => e) as OAuthV2TokenRefreshResponse);

    return Promise.all(refreshPromises);
  }

  /**
   * Returns search params from a URL and ignores protocol / hostname as those
   * aren't guaranteed to be accurate e.g. in x-forwarded- scenarios
   */
  private static extractSearchParams(req: IncomingMessage): URLSearchParams {
    const { searchParams } = new URL(req.url as string, `https://${req.headers.host}`);
    return searchParams;
  }

  /**
   * Returns a URL that is suitable for including in an Add to Slack button
   * Uses stateStore to generate a value for the state query param.
   */
  public async generateInstallUrl(options: InstallURLOptions, stateVerification: boolean = true): Promise<string> {
    const slackURL = new URL(this.authorizationUrl);

    if (options.scopes === undefined || options.scopes === null) {
      throw new GenerateInstallUrlError('You must provide a scope parameter when calling generateInstallUrl');
    }

    // scope
    let scopes: string;
    if (options.scopes instanceof Array) {
      scopes = options.scopes.join(',');
    } else {
      scopes = options.scopes;
    }
    const params = new URLSearchParams(`scope=${scopes}`);

    // generate state
    if (stateVerification && this.stateStore) {
      const state = await this.stateStore.generateStateParam(options, new Date());
      params.append('state', state);
    }

    // client id
    params.append('client_id', this.clientId);

    // redirect uri
    if (options.redirectUri !== undefined) {
      params.append('redirect_uri', options.redirectUri);
    }

    // team id
    if (options.teamId !== undefined) {
      params.append('team', options.teamId);
    }

    // user scope, only available for OAuth v2
    if (options.userScopes !== undefined && this.authVersion === 'v2') {
      let userScopes: string;
      if (options.userScopes instanceof Array) {
        userScopes = options.userScopes.join(',');
      } else {
        userScopes = options.userScopes;
      }
      params.append('user_scope', userScopes);
    }
    slackURL.search = params.toString();
    return slackURL.toString();
  }

  /**
   * This method handles the incoming request to the callback URL.
   * It can be used as a RequestListener in almost any HTTP server
   * framework.
   *
   * Verifies the state using the stateStore, exchanges the grant in the
   * query params for an access token, and stores token and associated data
   * in the installationStore.
   */
  public async handleCallback(
    req: IncomingMessage,
    res: ServerResponse,
    options?: CallbackOptions,
    installOptions?: InstallURLOptions,
  ): Promise<void> {
    let code: string;
    let flowError: string;
    let state: string;
    try {
      if (req.url !== undefined) {
        // Note: Protocol/ host of object are not necessarily accurate
        // and shouldn't be relied on
        // intended only for accessing searchParams only
        const searchParams = InstallProvider.extractSearchParams(req);
        flowError = searchParams.get('error') as string;
        if (flowError === 'access_denied') {
          throw new AuthorizationError('User cancelled the OAuth installation flow!');
        }
        code = searchParams.get('code') as string;
        state = searchParams.get('state') as string;
        if (!code) {
          throw new MissingCodeError('Redirect url is missing the required code query parameter');
        }
        if (this.stateVerification && !state) {
          throw new MissingStateError('Redirect url is missing the state query parameter. If this is intentional, see options for disabling default state verification.');
        }
      } else {
        throw new UnknownError('Something went wrong');
      }
      // If state verification is enabled, attempt to verify, otherwise ignore
      if (this.stateVerification && this.stateStore) {
        // eslint-disable-next-line no-param-reassign
        installOptions = await this.stateStore.verifyStateParam(new Date(), state);
      }
      if (!installOptions) {
        const emptyInstallOptions: InstallURLOptions = { scopes: [] };
        // eslint-disable-next-line no-param-reassign
        installOptions = emptyInstallOptions;
      }

      const client = new WebClient(undefined, this.clientOptions);

      // Start: Build the installation object
      let installation: Installation;
      let resp: OAuthV1Response | OAuthV2Response;

      if (this.authVersion === 'v1') {
        // convert response type from WebApiCallResult to OAuthResponse
        const v1Resp = await client.oauth.access({
          code,
          client_id: this.clientId,
          client_secret: this.clientSecret,
          redirect_uri: installOptions.redirectUri,
        }) as OAuthV1Response;

        // resp obj for v1 - https://api.slack.com/methods/oauth.access#response
        const v1Installation: Installation<'v1', false> = {
          team: { id: v1Resp.team_id, name: v1Resp.team_name },
          enterprise: v1Resp.enterprise_id === null ? undefined : { id: v1Resp.enterprise_id },
          user: {
            token: v1Resp.access_token,
            scopes: v1Resp.scope.split(','),
            id: v1Resp.user_id,
          },

          // synthesized properties: enterprise installation is unsupported in v1 auth
          isEnterpriseInstall: false,
          authVersion: 'v1',
        };

        // only can get botId if bot access token exists
        // need to create a botUser + request bot scope to have this be part of resp
        if (v1Resp.bot !== undefined) {
          const authResult = await runAuthTest(v1Resp.bot.bot_access_token, this.clientOptions);
          // We already tested that a bot user was in the response, so we know the following bot_id will be defined
          const botId = authResult.bot_id as string;

          v1Installation.bot = {
            id: botId,
            scopes: ['bot'],
            token: v1Resp.bot.bot_access_token,
            userId: v1Resp.bot.bot_user_id,
          };
        }

        resp = v1Resp;
        installation = v1Installation;
      } else {
        // convert response type from WebApiCallResult to OAuthResponse
        const v2Resp = await client.oauth.v2.access({
          code,
          client_id: this.clientId,
          client_secret: this.clientSecret,
          redirect_uri: installOptions.redirectUri,
        }) as OAuthV2Response;

        // resp obj for v2 - https://api.slack.com/methods/oauth.v2.access#response
        const v2Installation: Installation<'v2', boolean> = {
          team: v2Resp.team === null ? undefined : v2Resp.team,
          enterprise: v2Resp.enterprise == null ? undefined : v2Resp.enterprise,
          user: {
            token: v2Resp.authed_user.access_token,
            scopes: v2Resp.authed_user.scope?.split(','),
            id: v2Resp.authed_user.id,
          },
          tokenType: v2Resp.token_type,
          isEnterpriseInstall: v2Resp.is_enterprise_install,
          appId: v2Resp.app_id,

          // synthesized properties
          authVersion: 'v2',
        };

        const currentUTC = Math.floor(Date.now() / 1000); // utc, seconds

        // Installation has Bot Token
        if (v2Resp.access_token !== undefined && v2Resp.scope !== undefined && v2Resp.bot_user_id !== undefined) {
          const authResult = await runAuthTest(v2Resp.access_token, this.clientOptions);

          v2Installation.bot = {
            scopes: v2Resp.scope.split(','),
            token: v2Resp.access_token,
            userId: v2Resp.bot_user_id,
            id: authResult.bot_id as string,
          };

          if (v2Resp.is_enterprise_install) {
            v2Installation.enterpriseUrl = authResult.url;
          }

          // Token Rotation is Enabled
          if (v2Resp.refresh_token !== undefined && v2Resp.expires_in !== undefined) {
            v2Installation.bot.refreshToken = v2Resp.refresh_token;
            v2Installation.bot.expiresAt = currentUTC + v2Resp.expires_in; // utc, seconds
          }
        }

        // Installation has User Token
        if (v2Resp.authed_user !== undefined && v2Resp.authed_user.access_token !== undefined) {
          if (v2Resp.is_enterprise_install && v2Installation.enterpriseUrl === undefined) {
            const authResult = await runAuthTest(v2Resp.authed_user.access_token, this.clientOptions);
            v2Installation.enterpriseUrl = authResult.url;
          }

          // Token Rotation is Enabled
          if (v2Resp.authed_user.refresh_token !== undefined && v2Resp.authed_user.expires_in !== undefined) {
            v2Installation.user.refreshToken = v2Resp.authed_user.refresh_token;
            v2Installation.user.expiresAt = currentUTC + v2Resp.authed_user.expires_in; // utc, seconds
          }
        }

        resp = v2Resp;
        installation = v2Installation;
      }

      if (resp.incoming_webhook !== undefined) {
        installation.incomingWebhook = {
          url: resp.incoming_webhook.url,
          channel: resp.incoming_webhook.channel,
          channelId: resp.incoming_webhook.channel_id,
          configurationUrl: resp.incoming_webhook.configuration_url,
        };
      }
      if (installOptions && installOptions.metadata !== undefined) {
        // Pass the metadata in state parameter if exists.
        // Developers can use the value for additional/custom data associated with the installation.
        installation.metadata = installOptions.metadata;
      }
      // End: Build the installation object

      // Save installation object to installation store
      if (installation.isEnterpriseInstall) {
        await this.installationStore.storeInstallation(installation as OrgInstallation, this.logger);
      } else {
        await this.installationStore.storeInstallation(installation as Installation<'v1' | 'v2', false>, this.logger);
      }

      // Call the success callback
      if (options !== undefined && options.success !== undefined) {
        this.logger.debug('calling passed in options.success');
        options.success(installation, installOptions, req, res);
      } else {
        this.logger.debug('run built-in success function');
        defaultCallbackSuccess(installation, installOptions, req, res);
      }
    } catch (error: any) {
      this.logger.error(error);

      if (!installOptions) {
        // To make the `installOptions` type compatible with `CallbackOptions#failure` signature
        const emptyInstallOptions: InstallURLOptions = { scopes: [] };
        // eslint-disable-next-line no-param-reassign
        installOptions = emptyInstallOptions;
      }

      // Call the failure callback
      if (options !== undefined && options.failure !== undefined) {
        this.logger.debug('calling passed in options.failure');
        options.failure(error, installOptions, req, res);
      } else {
        this.logger.debug('run built-in failure function');
        defaultCallbackFailure(error, installOptions, req, res);
      }
    }
  }
}

// Response shape from oauth.v2.access - https://api.slack.com/methods/oauth.v2.access#response
export interface OAuthV2Response extends WebAPICallResult {
  app_id: string;
  authed_user: {
    id: string,
    scope?: string,
    access_token?: string,
    token_type?: string,
    refresh_token?: string,
    expires_in?: number,
  };
  scope?: string;
  token_type?: 'bot';
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  bot_user_id?: string;
  team: { id: string, name: string } | null;
  enterprise: { name: string, id: string } | null;
  is_enterprise_install: boolean;
  incoming_webhook?: {
    url: string,
    channel: string,
    channel_id: string,
    configuration_url: string,
  };
}

export interface OAuthV2TokenRefreshResponse extends WebAPICallResult {
  app_id: string;
  scope: string;
  token_type: 'bot' | 'user';
  access_token: string;
  refresh_token: string;
  expires_in: number;
  bot_user_id?: string;
  team: { id: string, name: string };
  enterprise: { name: string, id: string } | null;
  is_enterprise_install: boolean;
}

// ------------------------------------------
// Internals
// ------------------------------------------

// Response shape from oauth.access - https://api.slack.com/methods/oauth.access#response
interface OAuthV1Response extends WebAPICallResult {
  access_token: string;
  // scope parameter isn't returned in workspace apps
  scope: string;
  team_name: string;
  team_id: string;
  enterprise_id: string | null;
  // if they request bot user token
  bot?: { bot_user_id: string, bot_access_token: string };
  incoming_webhook?: {
    url: string,
    channel: string,
    channel_id: string,
    configuration_url: string,
  };
  // app_id is currently undefined but leaving it in here incase the v1 method adds it
  app_id: string | undefined;
  // TODO: removed optional because logically there's no case where a user_id cannot be provided, but needs verification
  user_id: string; // Not documented but showing up on responses
}

// ---------------------
// Gets the bot_id using the `auth.test` method.

interface AuthTestResult extends WebAPICallResult {
  bot_id?: string;
  url?: string;
}

async function runAuthTest(token: string, clientOptions: WebClientOptions): Promise<AuthTestResult> {
  const client = new WebClient(token, clientOptions);
  const authResult = await client.auth.test();
  return authResult as any as AuthTestResult;
}

// ---------------------
// token rotation

/**
 * detectExpiredOrExpiringTokens determines access tokens' eligibility for refresh.
 *
 * The return value is an Array of expired or soon-to-expire access tokens.
 */
function detectExpiredOrExpiringTokens(authResult: AuthorizeResult, currentUTCSec: number): string[] {
  const tokensToRefresh: string[] = [];
  const EXPIRY_WINDOW: number = 7200; // 2 hours

  if (authResult.botRefreshToken &&
    (authResult.botTokenExpiresAt !== undefined && authResult.botTokenExpiresAt !== null)) {
    const botTokenExpiresIn = authResult.botTokenExpiresAt - currentUTCSec;
    if (botTokenExpiresIn <= EXPIRY_WINDOW) {
      tokensToRefresh.push(authResult.botRefreshToken);
    }
  }

  if (authResult.userRefreshToken &&
    (authResult.userTokenExpiresAt !== undefined && authResult.userTokenExpiresAt !== null)) {
    const userTokenExpiresIn = authResult.userTokenExpiresAt - currentUTCSec;
    if (userTokenExpiresIn <= EXPIRY_WINDOW) {
      tokensToRefresh.push(authResult.userRefreshToken);
    }
  }

  return tokensToRefresh;
}
