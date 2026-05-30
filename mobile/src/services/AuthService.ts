/**
 * T046 — AuthService: AWS Cognito Identity Pool guest credentials.
 *
 * Obtains short-lived IAM credentials for unauthenticated (guest) identities
 * directly via the Cognito Identity REST API, without a heavy AWS SDK dependency.
 * Credentials are cached in memory and refreshed before expiry.
 *
 * Environment configuration (read from process.env or Expo Constants):
 *   AWS_COGNITO_IDENTITY_POOL_ID  — e.g. "us-east-1:xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
 *   AWS_REGION                    — e.g. "us-east-1"
 */

export interface AwsCredentialIdentity {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration: Date;
}

// ---------------------------------------------------------------------------
// Configuration helpers
// ---------------------------------------------------------------------------

function getEnv(key: string): string {
  // Expo bundles env vars as process.env at build time; fall through to
  // __DEV__ constants if needed. Throw clearly if missing so misconfiguration
  // surfaces at startup rather than at first sync attempt.
  const value = process.env[key];
  if (!value) {
    throw new Error(
      `[AuthService] Missing required environment variable: ${key}. ` +
        'Set it in your .env file and ensure it is forwarded via app.config.js extra.',
    );
  }
  return value;
}

function getIdentityPoolId(): string {
  return getEnv('AWS_COGNITO_IDENTITY_POOL_ID');
}

function getRegion(): string {
  // Region can be inferred from the identity pool id prefix
  const poolId = getIdentityPoolId();
  const region = process.env['AWS_REGION'] ?? poolId.split(':')[0];
  if (!region) throw new Error('[AuthService] Cannot determine AWS region');
  return region;
}

// ---------------------------------------------------------------------------
// Cognito Identity REST API helpers
// ---------------------------------------------------------------------------

interface CognitoGetIdResponse {
  IdentityId: string;
}

interface CognitoCredentials {
  AccessKeyId: string;
  SecretKey: string;
  SessionToken: string;
  Expiration: number; // Unix epoch seconds
}

interface CognitoGetCredentialsResponse {
  Credentials: CognitoCredentials;
  IdentityId: string;
}

async function cognitoPost<T>(region: string, action: string, body: object): Promise<T> {
  const endpoint = `https://cognito-identity.${region}.amazonaws.com/`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-amz-json-1.1',
      'X-Amz-Target': `AmazonCognitoIdentity.${action}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`[AuthService] Cognito ${action} failed (${response.status}): ${text}`);
  }

  return response.json() as Promise<T>;
}

async function getId(region: string, identityPoolId: string): Promise<string> {
  const data = await cognitoPost<CognitoGetIdResponse>(region, 'GetId', {
    IdentityPoolId: identityPoolId,
  });
  return data.IdentityId;
}

async function getCredentialsForIdentity(
  region: string,
  identityId: string,
): Promise<AwsCredentialIdentity> {
  const data = await cognitoPost<CognitoGetCredentialsResponse>(
    region,
    'GetCredentialsForIdentity',
    { IdentityId: identityId },
  );
  const creds = data.Credentials;
  return {
    accessKeyId: creds.AccessKeyId,
    secretAccessKey: creds.SecretKey,
    sessionToken: creds.SessionToken,
    expiration: new Date(creds.Expiration * 1000),
  };
}

// ---------------------------------------------------------------------------
// AuthService singleton
// ---------------------------------------------------------------------------

/** Refresh credentials this many milliseconds before their actual expiry. */
const REFRESH_BUFFER_MS = 5 * 60 * 1000; // 5 minutes

class AuthServiceClass {
  private cachedCredentials: AwsCredentialIdentity | null = null;
  private cachedIdentityId: string | null = null;
  private inflightRequest: Promise<AwsCredentialIdentity> | null = null;

  /**
   * Returns valid AWS credentials, fetching/refreshing from Cognito if needed.
   * Concurrent calls share a single in-flight request to avoid thundering herd.
   */
  async getCredentials(): Promise<AwsCredentialIdentity> {
    if (this.cachedCredentials && this.isValid(this.cachedCredentials)) {
      return this.cachedCredentials;
    }
    // Deduplicate concurrent callers
    if (this.inflightRequest) {
      return this.inflightRequest;
    }
    this.inflightRequest = this.fetchCredentials().finally(() => {
      this.inflightRequest = null;
    });
    return this.inflightRequest;
  }

  /** Force a credential refresh (useful after a 403 / expired response). */
  async refresh(): Promise<AwsCredentialIdentity> {
    this.cachedCredentials = null;
    this.cachedIdentityId = null;
    return this.getCredentials();
  }

  private isValid(creds: AwsCredentialIdentity): boolean {
    return creds.expiration.getTime() - Date.now() > REFRESH_BUFFER_MS;
  }

  private async fetchCredentials(): Promise<AwsCredentialIdentity> {
    const poolId = getIdentityPoolId();
    const region = getRegion();

    // Reuse identity ID across refresh cycles to avoid creating unbounded identities
    if (!this.cachedIdentityId) {
      this.cachedIdentityId = await getId(region, poolId);
    }

    const creds = await getCredentialsForIdentity(region, this.cachedIdentityId);
    this.cachedCredentials = creds;
    return creds;
  }
}

export const AuthService = new AuthServiceClass();
