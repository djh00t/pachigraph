import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

assert.match(
  process.env.PACHIGRAPH_TEST_DATABASE_NAME ?? '',
  /^pachigraph_test_(?:ci|[a-f0-9]{32})$/,
);
assert.equal(
  process.env.DATABASE_URL,
  process.env.PACHIGRAPH_TEST_DATABASE_URL,
);
assert.equal(
  new URL(process.env.DATABASE_URL).pathname,
  `/${process.env.PACHIGRAPH_TEST_DATABASE_NAME}`,
);
const { publicKey, privateKey } = await generateKeyPair('RS256');
const jwk = { ...(await exportJWK(publicKey)), kid: 'smoke', alg: 'RS256' };
// This probe stub exercises startup only; storage integration tests cover S3 commands.
const dependencies = createServer((req, res) => {
  if (req.url === '/jwks') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ keys: [jwk] }));
  } else if (req.method === 'HEAD') {
    res.end();
  } else {
    res.writeHead(501).end();
  }
});
dependencies.listen(0, '127.0.0.1');
await once(dependencies, 'listening');
const dependencyUrl = `http://127.0.0.1:${dependencies.address().port}`;
const reservation = createServer();
reservation.listen(0, '127.0.0.1');
await once(reservation, 'listening');
const port = reservation.address().port;
await new Promise((done) => reservation.close(done));
const base = `http://127.0.0.1:${port}`;
const token = await new SignJWT({ name: 'Synthetic owner' })
  .setProtectedHeader({ alg: 'RS256', kid: 'smoke' })
  .setSubject('standalone-smoke')
  .setIssuer(dependencyUrl)
  .setAudience('pachigraph')
  .setIssuedAt()
  .setExpirationTime('5m')
  .sign(privateKey);
const applicationEnvironment = {
  DATABASE_URL: process.env.DATABASE_URL,
  HOST: '127.0.0.1',
  PORT: String(port),
  VINEXT_TRUSTED_HOSTS: 'pachigraph.test',
  S3_BUCKET: 'synthetic',
  S3_ENDPOINT: dependencyUrl,
  S3_FORCE_PATH_STYLE: 'true',
  AWS_ACCESS_KEY_ID: 'synthetic',
  AWS_SECRET_ACCESS_KEY: 'synthetic',
  PACHIGRAPH_OIDC_ISSUER: dependencyUrl,
  PACHIGRAPH_OIDC_JWKS_URL: `${dependencyUrl}/jwks`,
  PACHIGRAPH_ALLOWED_SUBJECTS: 'standalone-smoke',
};
const image = process.env.PACHIGRAPH_SMOKE_IMAGE;
const containerName = `pachigraph-smoke-${port}`;
const isolatedDirectory = mkdtempSync(join(tmpdir(), 'pachigraph-smoke-'));
cpSync(resolve('dist/standalone'), isolatedDirectory, { recursive: true });
const child = spawn(
  image ? 'docker' : process.execPath,
  image
    ? [
        'run',
        '--rm',
        '--name',
        containerName,
        '--network',
        'host',
        '--read-only',
        '--user',
        '1000:1000',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
        '--tmpfs',
        '/tmp:rw,nosuid,size=64m',
        ...Object.keys(applicationEnvironment).flatMap((name) => [
          '--env',
          name,
        ]),
        image,
      ]
    : ['server.mjs'],
  {
    cwd: isolatedDirectory,
    env: { ...process.env, ...applicationEnvironment },
    stdio: ['ignore', 'ignore', 'pipe'],
  },
);
let stderr = '';
child.stderr.on('data', (part) => {
  stderr = (stderr + part).slice(-4000);
});
const exited = once(child, 'exit');
const request = (path, bearer, method = 'GET', body) =>
  fetch(base + path, {
    method,
    headers: {
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      'content-type': 'application/json',
      'x-forwarded-host': 'pachigraph.test',
      'x-forwarded-proto': 'https',
      origin: 'https://pachigraph.test',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
let keyId;
const client = new Client({ name: 'standalone-smoke', version: '1' });
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null)
      throw new Error('Standalone exited before ready');
    try {
      ready = (await request('/ready')).ok;
    } catch {
      /* Startup may still be binding. */
    }
    if (ready) break;
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.ok(ready, 'Standalone readiness');
  assert.equal((await request('/health')).status, 200);
  const page = await request('/', token);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Find the thought/);
  assert.equal((await request('/keys', token)).status, 200);
  assert.equal((await request('/api/status')).status, 401);
  const forged = await fetch(base + '/api/status', {
    headers: { 'oai-user-id': 'standalone-smoke' },
  });
  assert.equal(forged.status, 401);
  const minted = await request('/api/keys', token, 'POST', {
    scope: 'read',
    days: 1,
  });
  assert.equal(minted.status, 200);
  const { key, id } = await minted.json();
  keyId = id;
  assert.match(key, /^pg_[a-f0-9]{64}$/);
  assert.equal((await request('/api/status', key)).status, 200);
  assert.equal((await request('/api/ingest', key, 'POST', {})).status, 403);
  assert.equal((await request('/api/keys', key)).status, 401);
  await client.connect(
    new StreamableHTTPClientTransport(new URL(base + '/mcp'), {
      requestInit: { headers: { authorization: `Bearer ${key}` } },
    }),
  );
  assert.deepEqual(
    (await client.listTools()).tools.map((tool) => tool.name).sort(),
    ['fetch', 'search', 'status'],
  );
  const result = await client.callTool({ name: 'status', arguments: {} });
  assert.equal(result.isError, undefined);
  assert.equal(JSON.parse(result.content[0].text).records, 0);
  assert.equal(
    (await request(`/api/keys?id=${id}`, token, 'DELETE')).status,
    200,
  );
  keyId = undefined;
  assert.equal((await request('/api/status', key)).status, 401);
  console.log(
    'Standalone smoke passed: readiness, JWT, scoped key, SDK MCP, revocation',
  );
} catch (error) {
  let diagnostic = stderr;
  const database = new URL(process.env.DATABASE_URL);
  for (const value of [
    process.env.DATABASE_URL,
    database.password,
    decodeURIComponent(database.password),
  ]) {
    if (value) diagnostic = diagnostic.replaceAll(value, '[redacted]');
  }
  console.error(diagnostic);
  throw error;
} finally {
  if (keyId)
    await request(`/api/keys?id=${keyId}`, token, 'DELETE').catch(() => {});
  await client.close().catch(() => {});
  child.kill('SIGTERM');
  const force = setTimeout(() => child.kill('SIGKILL'), 5000);
  await exited;
  clearTimeout(force);
  rmSync(isolatedDirectory, { recursive: true, force: true });
  if (image) {
    try {
      execFileSync('docker', ['rm', '--force', containerName], {
        stdio: 'ignore',
      });
    } catch {
      /* --rm already removes a cleanly stopped container. */
    }
  }
  await new Promise((done) => dependencies.close(done));
  if (child.exitCode !== 0)
    console.error(
      'Standalone failed; inspect locally with protected logs. Stderr bytes:',
      stderr.length,
    );
  assert.equal(
    child.exitCode,
    0,
    'Application must stop cleanly after SIGTERM',
  );
}
