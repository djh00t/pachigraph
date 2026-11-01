import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { after, before, beforeEach, test } from 'node:test';
import {
  exportJWK,
  generateKeyPair,
  SignJWT,
  type CryptoKey,
  type JWTPayload,
} from 'jose';
import { migrate } from '../db/migrate.ts';
import {
  resolveTenant,
  sessionPrincipal,
  verifyUser,
  type AuthEnvironment,
  type TenantId,
  type VerifiedUser,
} from '../server/auth.ts';
import { clearStorage, testPool } from './storage-support.ts';

const pool = testPool();
const TENANT_A = 't-aaaaaaaaaaaaaaaa';
const TENANT_B = 't-bbbbbbbbbbbbbbbb';

let issuer: string;
let privateKey: CryptoKey;
let foreignKey: CryptoKey;
let server: Server;
let jwks: { keys: Record<string, unknown>[] };
let jwksRequests = 0;

before(async () => {
  const signing = await generateKeyPair('RS256');
  const foreign = await generateKeyPair('RS256');
  privateKey = signing.privateKey;
  foreignKey = foreign.privateKey;
  jwks = {
    keys: [
      {
        ...(await exportJWK(signing.publicKey)),
        alg: 'RS256',
        kid: 'pachigraph-test',
        use: 'sig',
      },
    ],
  };
  server = createServer((request, response) => {
    jwksRequests += 1;
    response.setHeader('content-type', 'application/json');
    response.end(
      request.url === '/malformed' ? '{"keys":[{}]}' : JSON.stringify(jwks),
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  issuer = `http://127.0.0.1:${address.port}/realms/pachigraph`;
  await migrate(pool);
});

beforeEach(async () => clearStorage(pool));

after(async () => {
  server.close();
  await once(server, 'close');
  await pool.end();
});

function environment(
  overrides: Partial<AuthEnvironment> = {},
): AuthEnvironment {
  return {
    PACHIGRAPH_OIDC_ISSUER: issuer,
    PACHIGRAPH_OIDC_AUDIENCE: 'pachigraph',
    PACHIGRAPH_ALLOWED_SUBJECTS: ' allowed-subject , second-subject ',
    PACHIGRAPH_OIDC_JWKS_URL: issuer.replace('/realms/pachigraph', '/jwks'),
    ...overrides,
  };
}

async function token({
  claims = {},
  signingKey = privateKey,
  tokenIssuer = issuer,
  audience = 'pachigraph',
  expires = '5m',
}: {
  claims?: JWTPayload;
  signingKey?: CryptoKey;
  tokenIssuer?: string;
  audience?: string;
  expires?: string | number;
} = {}) {
  return new SignJWT({
    sub: 'allowed-subject',
    email: 'reader@example.test',
    name: 'Archive Reader',
    ...claims,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'pachigraph-test' })
    .setIssuer(tokenIssuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(expires)
    .sign(signingKey);
}

function requestHeaders(value?: string, extra: Record<string, string> = {}) {
  return new Headers({
    ...(value ? { authorization: `Bearer ${value}` } : {}),
    ...extra,
  });
}

test('verified access token supplies the owner and verified profile', async () => {
  const exp = 1_800_000_000;
  assert.deepEqual(
    await verifyUser(
      requestHeaders(await token({ expires: exp })),
      environment(),
    ),
    {
      userId: 'allowed-subject',
      displayName: 'Archive Reader',
      email: 'reader@example.test',
      fullName: 'Archive Reader',
      expiresAt: new Date(exp * 1000),
    },
  );
});

function requireTenant(id: TenantId) {
  return id;
}

test('TenantId rejects a plain string', () => {
  const id: string = TENANT_A;
  // @ts-expect-error plain string is not a TenantId
  requireTenant(id);
});

function profile(subject: string): VerifiedUser {
  return {
    userId: subject,
    displayName: subject,
    email: '',
    fullName: null,
    expiresAt: new Date('2026-04-01T00:00:00.000Z'),
  };
}

async function bind(subject: string, tenant: string, active = true) {
  await pool.query(
    `INSERT INTO pachigraph.tenants (id, active, max_records, max_bytes)
     VALUES ($1, $2, 1000000, 10737418240)`,
    [tenant, active],
  );
  await pool.query(
    `INSERT INTO pachigraph.tenant_members (subject, tenant_id)
     VALUES ($1, $2)`,
    [subject, tenant],
  );
  await pool.query(
    `INSERT INTO pachigraph.tenant_usage (tenant_id, records, bytes)
     VALUES ($1, 0, 0)`,
    [tenant],
  );
}

test('a bound subject in an active tenant resolves to that tenant', async () => {
  await bind('subject-a', TENANT_A);
  const user = profile('subject-a');
  const principal = await sessionPrincipal(pool, user);
  assert.equal(principal.tenant, TENANT_A);
  assert.equal(principal.subject, 'subject-a');
  assert.equal(principal.scope, 'session');
  assert.deepEqual(principal.expiresAt, user.expiresAt);
  assert.notEqual(principal.tenant, TENANT_B);
});

test('an unbound subject, an inactive tenant and an empty binding give 401', async () => {
  await bind('subject-b', TENANT_B, false);
  await assert.rejects(sessionPrincipal(pool, profile('subject-a')), {
    status: 401,
  });
  await assert.rejects(sessionPrincipal(pool, profile('subject-b')), {
    status: 401,
  });
  await assert.equal(await resolveTenant(pool, 'subject-b'), null);

  await pool.query(
    'ALTER TABLE pachigraph.tenant_members DROP CONSTRAINT tenant_members_tenant_id_fkey',
  );
  await pool.query(
    'ALTER TABLE pachigraph.tenant_members DROP CONSTRAINT tenant_members_tenant_id_len',
  );
  try {
    await pool.query(
      `INSERT INTO pachigraph.tenant_members (subject, tenant_id)
       VALUES ('subject-empty', '   ')`,
    );
    await assert.rejects(sessionPrincipal(pool, profile('subject-empty')), {
      status: 401,
    });
    assert.equal(await resolveTenant(pool, 'subject-empty'), null);
  } finally {
    await pool.query(
      `DELETE FROM pachigraph.tenant_members WHERE subject = 'subject-empty'`,
    );
    await pool.query(
      `ALTER TABLE pachigraph.tenant_members
       ADD CONSTRAINT tenant_members_tenant_id_len
       CHECK (length(trim(tenant_id)) > 0)`,
    );
    await pool.query(
      `ALTER TABLE pachigraph.tenant_members
       ADD CONSTRAINT tenant_members_tenant_id_fkey
       FOREIGN KEY (tenant_id) REFERENCES pachigraph.tenants (id)`,
    );
  }
});

test('removing a subject from the allowlist blocks new sign-in only and is not a gate', async () => {
  await bind('allowed-subject', TENANT_A);
  assert.equal(
    await verifyUser(
      requestHeaders(await token()),
      environment({ PACHIGRAPH_ALLOWED_SUBJECTS: 'second-subject' }),
    ),
    null,
  );
  assert.equal(await resolveTenant(pool, 'allowed-subject'), TENANT_A);
});

test('signature, issuer, audience, expiry and allowlist failures return no user', async () => {
  const cases = [
    token({ signingKey: foreignKey }),
    token({ tokenIssuer: issuer + '/wrong' }),
    token({ audience: 'another-service' }),
    token({ expires: Math.floor(Date.now() / 1000) - 60 }),
    token({ claims: { sub: 'denied-subject' } }),
    token({ claims: { sub: '' } }),
  ];
  for (const candidate of await Promise.all(cases)) {
    assert.equal(
      await verifyUser(requestHeaders(candidate), environment()),
      null,
    );
  }
});

test('unverified headers, API keys and malformed JWKS never become identity', async () => {
  const beforeRequests = jwksRequests;
  assert.equal(
    await verifyUser(
      requestHeaders(undefined, {
        'oai-authenticated-user-id': 'forged-oai',
        'x-user-id': 'forged-proxy',
      }),
      environment(),
    ),
    null,
  );
  assert.equal(
    await verifyUser(requestHeaders('pg_' + 'a'.repeat(64)), environment()),
    null,
  );
  assert.equal(jwksRequests, beforeRequests);
  assert.equal(
    await verifyUser(
      requestHeaders(await token()),
      environment({
        PACHIGRAPH_OIDC_JWKS_URL: issuer.replace(
          '/realms/pachigraph',
          '/malformed',
        ),
      }),
    ),
    null,
  );
});

test('invalid runtime trust configuration fails closed before JWKS fetch', async () => {
  const beforeRequests = jwksRequests;
  const valid = await token();
  assert.equal(
    await verifyUser(
      requestHeaders(valid),
      environment({ PACHIGRAPH_ALLOWED_SUBJECTS: '' }),
    ),
    null,
  );
  assert.equal(
    await verifyUser(
      requestHeaders(valid),
      environment({
        PACHIGRAPH_OIDC_ISSUER: 'http://keycloak.internal/realms/p',
      }),
    ),
    null,
  );
  assert.equal(jwksRequests, beforeRequests);
});

test('display name falls back from name to email to subject', async () => {
  const emailOnly = await token({ claims: { name: '', email: 'mail@test' } });
  const subjectOnly = await token({ claims: { name: '', email: '' } });
  assert.equal(
    (await verifyUser(requestHeaders(emailOnly), environment()))?.displayName,
    'mail@test',
  );
  assert.equal(
    (await verifyUser(requestHeaders(subjectOnly), environment()))?.displayName,
    'allowed-subject',
  );
});
