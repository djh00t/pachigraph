import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { Pool } from 'pg';
import { fail } from './http.ts';

export type AuthEnvironment = {
  readonly [name: string]: string | undefined;
  PACHIGRAPH_OIDC_ISSUER?: string;
  PACHIGRAPH_OIDC_AUDIENCE?: string;
  PACHIGRAPH_ALLOWED_SUBJECTS?: string;
  PACHIGRAPH_OIDC_JWKS_URL?: string;
};

export type TenantId = string & { readonly __brand: 'TenantId' };

export type Principal = {
  tenant: TenantId;
  subject: string;
  scope: 'read' | 'ingest' | 'session';
  expiresAt: Date;
};

export type VerifiedUser = {
  userId: string;
  displayName: string;
  email: string;
  fullName: string | null;
  expiresAt: Date;
};

const TENANT_ID = /^t-[0-9a-f]{16}$/;

const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function isLoopback(hostname: string) {
  return (
    hostname === 'localhost' ||
    hostname === '[::1]' ||
    /^127(?:\.\d{1,3}){3}$/.test(hostname)
  );
}

function endpoint(value: string, allowConfiguredHttp: boolean) {
  const url = new URL(value);
  if (url.username || url.password || url.hash) throw new Error('invalid URL');
  if (
    url.protocol !== 'https:' &&
    !(
      url.protocol === 'http:' &&
      (allowConfiguredHttp || isLoopback(url.hostname))
    )
  ) {
    throw new Error('insecure URL');
  }
  return url;
}

function claim(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : null;
}

export async function verifyUser(
  headers: Headers,
  environment: AuthEnvironment = process.env,
): Promise<VerifiedUser | null> {
  const authorization = headers.get('authorization');
  const match = authorization?.match(/^Bearer ([^\s]+)$/i);
  if (!match || match[1].startsWith('pg_')) return null;

  try {
    const issuer = environment.PACHIGRAPH_OIDC_ISSUER?.trim();
    if (!issuer) return null;
    endpoint(issuer, false);
    const allowed = new Set(
      environment.PACHIGRAPH_ALLOWED_SUBJECTS?.split(',')
        .map((subject) => subject.trim())
        .filter(Boolean) ?? [],
    );
    if (!allowed.size) return null;
    const configuredJwks = environment.PACHIGRAPH_OIDC_JWKS_URL?.trim();
    const jwksUrl = configuredJwks
      ? endpoint(configuredJwks, true)
      : endpoint(
          `${issuer.replace(/\/+$/, '')}/protocol/openid-connect/certs`,
          false,
        );
    const key = jwksUrl.href;
    let keySet = keySets.get(key);
    if (!keySet) {
      keySet = createRemoteJWKSet(jwksUrl);
      keySets.set(key, keySet);
    }
    const { payload } = await jwtVerify(match[1], keySet, {
      issuer,
      audience: environment.PACHIGRAPH_OIDC_AUDIENCE?.trim() || 'pachigraph',
    });
    const subject = claim(payload.sub);
    if (!subject || typeof payload.exp !== 'number' || !allowed.has(subject)) {
      return null;
    }
    const email = claim(payload.email) ?? '';
    const fullName = claim(payload.name);
    return {
      userId: subject,
      displayName: fullName ?? (email || subject),
      email,
      fullName,
      expiresAt: new Date(payload.exp * 1000),
    };
  } catch {
    return null;
  }
}

export async function boundTenant(
  pool: Pool,
  subject: string,
  tenantId: string,
): Promise<TenantId | null> {
  if (!subject.trim() || !TENANT_ID.test(tenantId)) return null;
  const result = await pool.query(
    `SELECT 1
     FROM pachigraph.tenant_members m
     JOIN pachigraph.tenants t ON t.id = m.tenant_id AND t.active
     WHERE m.subject = $1 AND m.tenant_id = $2
       AND length(trim(m.tenant_id)) > 0`,
    [subject, tenantId],
  );
  if (!result.rowCount) return null;
  return tenantId as TenantId;
}

export async function resolveTenant(
  pool: Pool,
  subject: string,
): Promise<TenantId | null> {
  if (!subject.trim()) return null;
  const result = await pool.query<{ tenant_id: string }>(
    `SELECT m.tenant_id
     FROM pachigraph.tenant_members m
     JOIN pachigraph.tenants t ON t.id = m.tenant_id AND t.active
     WHERE m.subject = $1 AND length(trim(m.tenant_id)) > 0`,
    [subject],
  );
  const tenantId = result.rows[0]?.tenant_id ?? '';
  if (!TENANT_ID.test(tenantId)) return null;
  return tenantId as TenantId;
}

export async function sessionPrincipal(
  pool: Pool,
  user: VerifiedUser,
): Promise<Principal> {
  const tenant = await resolveTenant(pool, user.userId);
  if (!tenant) fail(401);
  return {
    tenant,
    subject: user.userId,
    scope: 'session',
    expiresAt: user.expiresAt,
  };
}
