import assert from 'node:assert/strict';
import test from 'node:test';

async function objectsWith(
  send: (command: {
    constructor: { name: string };
    input: unknown;
  }) => Promise<unknown>,
) {
  let objectModule: typeof import('../server/objects.ts');
  try {
    objectModule = await import('../server/objects.ts');
  } catch (error) {
    assert.fail(`object module must exist: ${String(error)}`);
  }
  return objectModule.createObjects({
    bucket: 'test-bucket',
    client: { send },
  });
}

test('immutable put checks existence and uses an S3 precondition', async () => {
  const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  const objects = await objectsWith(async (command) => {
    calls.push({
      name: command.constructor.name,
      input: command.input as Record<string, unknown>,
    });
    if (command.constructor.name === 'HeadObjectCommand')
      throw Object.assign(new Error('missing'), {
        $metadata: { httpStatusCode: 404 },
      });
    return {};
  });
  await objects.putImmutable('owner/thread/source/revision', '{"a":1}');
  assert.deepEqual(
    calls.map((call) => call.name),
    ['HeadObjectCommand', 'PutObjectCommand'],
  );
  assert.deepEqual(calls[1].input, {
    Bucket: 'test-bucket',
    Key: 'owner/thread/source/revision',
    Body: '{"a":1}',
    ContentType: 'application/json',
    IfNoneMatch: '*',
  });
});

test('immutable put skips existing objects and only ignores precondition failure', async () => {
  let calls = 0;
  const existing = await objectsWith(async () => {
    calls += 1;
    return {};
  });
  await existing.putImmutable('key', 'body');
  assert.equal(calls, 1);

  const raced = await objectsWith(async (command) => {
    if (command.constructor.name === 'HeadObjectCommand')
      throw Object.assign(new Error('missing'), {
        $metadata: { httpStatusCode: 404 },
      });
    throw Object.assign(new Error('exists'), {
      $metadata: { httpStatusCode: 412 },
    });
  });
  await raced.putImmutable('key', 'body');

  const failed = await objectsWith(async (command) => {
    if (command.constructor.name === 'HeadObjectCommand')
      throw Object.assign(new Error('missing'), {
        $metadata: { httpStatusCode: 404 },
      });
    throw new Error('S3 unavailable');
  });
  await assert.rejects(failed.putImmutable('key', 'body'), /S3 unavailable/);
});

test('get returns text, missing returns null, and readiness checks the bucket', async () => {
  const calls: string[] = [];
  const objects = await objectsWith(async (command) => {
    calls.push(command.constructor.name);
    if (command.constructor.name === 'GetObjectCommand') {
      return { Body: { transformToString: async () => '{"ok":true}' } };
    }
    return {};
  });
  assert.equal(await objects.getText('key'), '{"ok":true}');
  await objects.check();
  assert.deepEqual(calls, ['GetObjectCommand', 'HeadBucketCommand']);

  const missing = await objectsWith(async () => {
    throw Object.assign(new Error('missing'), { name: 'NoSuchKey' });
  });
  assert.equal(await missing.getText('key'), null);
});

test('prefix deletion paginates and surfaces per-object errors', async () => {
  const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  const objects = await objectsWith(async (command) => {
    const input = command.input as Record<string, unknown>;
    calls.push({ name: command.constructor.name, input });
    if (command.constructor.name === 'ListObjectsV2Command') {
      return input.ContinuationToken
        ? { Contents: [{ Key: 'prefix/b' }], IsTruncated: false }
        : {
            Contents: [{ Key: 'prefix/a' }],
            IsTruncated: true,
            NextContinuationToken: 'next',
          };
    }
    return {};
  });
  await objects.deletePrefix('prefix/');
  assert.deepEqual(
    calls.map((call) => call.name),
    [
      'ListObjectsV2Command',
      'DeleteObjectsCommand',
      'ListObjectsV2Command',
      'DeleteObjectsCommand',
    ],
  );
  assert.equal(calls[2].input.ContinuationToken, 'next');

  const failed = await objectsWith(async (command) =>
    command.constructor.name === 'ListObjectsV2Command'
      ? { Contents: [{ Key: 'prefix/a' }], IsTruncated: false }
      : { Errors: [{ Key: 'prefix/a', Code: 'AccessDenied' }] },
  );
  await assert.rejects(failed.deletePrefix('prefix/'), /AccessDenied/);
});
