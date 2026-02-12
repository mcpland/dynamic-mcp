import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';

export interface JwtAuthConfig {
  enabled: boolean;
  jwksUrl: string;
  issuer: string;
  audience: string;
  requiredScopes: string[];
}

export class JwtAuthVerifier {
  private readonly config: JwtAuthConfig;
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(config: JwtAuthConfig) {
    this.config = config;
    this.jwks = createRemoteJWKSet(new URL(config.jwksUrl));
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const { payload } = await jwtVerify(token, this.jwks, {
      issuer: this.config.issuer,
      audience: this.config.audience
    });

    const claimRecord = payload as Record<string, unknown>;
    const scopes = extractScopes(claimRecord);
    ensureScopes(scopes, this.config.requiredScopes);

    const clientId = extractClientId(claimRecord);

    return {
      token,
      clientId,
      scopes,
      expiresAt: payload.exp,
      extra: {
        sub: claimRecord.sub,
        iss: claimRecord.iss,
        aud: claimRecord.aud
      }
    };
  }
}

function extractScopes(payload: Record<string, unknown>): string[] {
  const scopes = new Set<string>();

  if (typeof payload.scope === 'string') {
    for (const scope of payload.scope.split(/\s+/)) {
      const trimmed = scope.trim();
      if (trimmed.length > 0) {
        scopes.add(trimmed);
      }
    }
  }

  if (Array.isArray(payload.scp)) {
    for (const scope of payload.scp) {
      if (typeof scope === 'string' && scope.trim().length > 0) {
        scopes.add(scope.trim());
      }
    }
  } else if (typeof payload.scp === 'string' && payload.scp.trim().length > 0) {
    scopes.add(payload.scp.trim());
  }

  return [...scopes].sort();
}

function ensureScopes(scopes: string[], requiredScopes: string[]): void {
  if (requiredScopes.length === 0) {
    return;
  }

  const scopeSet = new Set(scopes);
  for (const required of requiredScopes) {
    if (!scopeSet.has(required)) {
      throw new Error(`Missing required scope: ${required}`);
    }
  }
}

function extractClientId(payload: Record<string, unknown>): string {
  for (const candidate of [payload.client_id, payload.azp, payload.sub]) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate;
    }
  }

  throw new Error('JWT does not contain a usable client identifier.');
}
