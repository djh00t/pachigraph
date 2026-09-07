import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';
import {
  exportJWK,
  generateKeyPair,
  SignJWT,
  type CryptoKey,
  type JWTPayload,
} from 'jose';
import { verifyUser, type AuthEnvironment } from '../server/auth.ts';

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
});

after(async () => {
  server.close();
  await once(server, 'close');
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
  assert.deepEqual(
    await verifyUser(requestHeaders(await token()), environment()),
    {
      userId: 'allowed-subject',
      displayName: 'Archive Reader',
      email: 'reader@example.test',
      fullName: 'Archive Reader',
    },
  );
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
