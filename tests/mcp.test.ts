import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { handleMCP } from '../server/mcp.ts';

type RPCReply = {
  result: {
    serverInfo: { name: string };
    tools: { name: string }[];
    content: { text: string }[];
    isError?: boolean;
  };
};

const evidence = {
  id: 'record',
  thread_id: 'thread',
  timestamp: '2026-09-07T00:00:00Z',
  text: 'known passage',
  record: {},
  citation: 'codex://threads/thread',
};
const calls: unknown[] = [];
const history = {
  search: async (owner: string, query: string) => {
    calls.push(['search', owner, query]);
    return { results: query === 'known' ? [evidence] : [] };
  },
  fetch: async (owner: string, id: string) => {
    calls.push(['fetch', owner, id]);
    return evidence;
  },
  ingest: async () => ({}),
  deleteThread: async () => ({}),
  status: async (owner: string) => {
    calls.push(['status', owner]);
    return {
      threads: 1,
      records: 1,
      text_bytes: 13,
      last_ingested_at: '2026-09-07T00:00:00Z',
    };
  },
};

function rpcRequest(
  method: string,
  params: unknown = {},
  extra: Record<string, string> = {},
) {
  return new Request('https://history.example/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...extra,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
}

test('MCP rejects absent owners, foreign origins and malformed bodies', async () => {
  assert.equal(
    (await handleMCP(rpcRequest('tools/list'), null, history)).status,
    401,
  );
  assert.equal(
    (
      await handleMCP(
        rpcRequest('tools/list', {}, { origin: 'https://evil.example' }),
        'owner',
        history,
      )
    ).status,
    403,
  );
  const malformed = new Request('https://history.example/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{',
  });
  assert.equal((await handleMCP(malformed, 'owner', history)).status, 400);
});

test('MCP lists only read tools and binds every call to the authenticated owner', async () => {
  const initialized = await handleMCP(
    rpcRequest('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    }),
    'bound-owner',
    history,
  );
  assert.equal(initialized.status, 200);
  assert.equal(
    ((await initialized.json()) as RPCReply).result.serverInfo.name,
    'pachigraph',
  );

  const listed = await handleMCP(
    rpcRequest('tools/list'),
    'bound-owner',
    history,
  );
  assert.deepEqual(
    ((await listed.json()) as RPCReply).result.tools
      .map((tool) => tool.name)
      .sort(),
    ['fetch', 'search', 'status'],
  );

  for (const [name, args] of [
    ['search', { query: 'known', owner: 'attacker' }],
    ['fetch', { id: 'record', owner: 'attacker' }],
    ['status', { owner: 'attacker' }],
  ] as const) {
    const response = await handleMCP(
      rpcRequest('tools/call', { name, arguments: args }),
      'bound-owner',
      history,
    );
    const result = ((await response.json()) as RPCReply).result;
    assert.equal(result.isError, undefined);
  }
  assert.deepEqual(calls.slice(-3), [
    ['search', 'bound-owner', 'known'],
    ['fetch', 'bound-owner', 'record'],
    ['status', 'bound-owner'],
  ]);
});

test('MCP tool errors hide internal storage details', async () => {
  const broken = {
    ...history,
    search: async () => {
      throw new Error('private database connection detail');
    },
  };
  const response = await handleMCP(
    rpcRequest('tools/call', {
      name: 'search',
      arguments: { query: 'known' },
    }),
    'owner',
    broken,
  );
  const result = ((await response.json()) as RPCReply).result;
  assert.equal(result.isError, true);
  assert.equal(JSON.stringify(result).includes('private database'), false);
});

test('maintained SDK client completes the stateless JSON lifecycle', async () => {
  const client = new Client({ name: 'compatibility-test', version: '1' });
  const transport = new StreamableHTTPClientTransport(
    new URL('https://history.example/mcp'),
    {
      fetch: async (url, init) =>
        handleMCP(new Request(url, init), 'sdk-owner', history),
    },
  );
  try {
    await client.connect(transport);
    assert.deepEqual(
      (await client.listTools()).tools.map((tool) => tool.name).sort(),
      ['fetch', 'search', 'status'],
    );
    const result = await client.callTool({
      name: 'search',
      arguments: { query: 'known' },
    });
    assert.ok(JSON.stringify(result.content).includes('known passage'));
    assert.deepEqual(calls.at(-1), ['search', 'sdk-owner', 'known']);
  } finally {
    await client.close();
  }
});
