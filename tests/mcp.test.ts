import assert from 'node:assert/strict';
import { test } from 'node:test';
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
  timestamp: '2026-09-05T00:00:00Z',
  text: 'known passage',
  record: {},
  citation: 'codex://threads/thread',
};
const history = {
  search: async (owner: string, q: string) => ({
    results: owner === 'owner' && q === 'known' ? [evidence] : [],
  }),
  fetch: async () => evidence,
  ingest: async () => ({}),
  deleteThread: async () => ({}),
  status: async () => ({}),
};
function request(
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
test('MCP rejects absent owner and foreign origins before handling tools', async () => {
  assert.equal(
    (await handleMCP(request('tools/list'), null, history)).status,
    401,
  );
  assert.equal(
    (
      await handleMCP(
        request('tools/list', {}, { origin: 'https://evil.example' }),
        'owner',
        history,
      )
    ).status,
    403,
  );
});
test('maintained MCP transport initializes, lists exactly search/fetch, and retrieves evidence', async () => {
  const init = await handleMCP(
    request('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    }),
    'owner',
    history,
  );
  assert.equal(init.status, 200);
  assert.equal(
    ((await init.json()) as RPCReply).result.serverInfo.name,
    'pachigraph',
  );
  const list = await handleMCP(request('tools/list'), 'owner', history);
  assert.deepEqual(
    ((await list.json()) as RPCReply).result.tools
      .map((t: { name: string }) => t.name)
      .sort(),
    ['fetch', 'search'],
  );
  for (const [name, args] of [
    ['search', { query: 'known' }],
    ['fetch', { id: 'record' }],
  ] as const) {
    const response = await handleMCP(
      request('tools/call', { name, arguments: args }),
      'owner',
      history,
    );
    const result = ((await response.json()) as RPCReply).result;
    assert.equal(result.isError, undefined);
    assert.ok(result.content[0].text.includes('known passage'));
    assert.ok(result.content[0].text.includes('codex://threads/thread'));
  }
});
test('MCP errors suppress exception details from storage', async () => {
  const bad = {
    ...history,
    search: async () => {
      throw new Error('secret database details');
    },
  };
  const response = await handleMCP(
    request('tools/call', { name: 'search', arguments: { query: 'known' } }),
    'owner',
    bad,
  );
  const result = ((await response.json()) as RPCReply).result;
  assert.equal(result.isError, true);
  assert.equal(JSON.stringify(result).includes('secret database'), false);
});

test('maintained SDK client completes the stateless HTTP lifecycle', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } =
    await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const client = new Client({ name: 'compatibility-test', version: '1' });
  const transport = new StreamableHTTPClientTransport(
    new URL('https://history.example/mcp'),
    {
      fetch: async (url, init) =>
        handleMCP(new Request(url, init), 'owner', history),
    },
  );
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 2);
    const result = await client.callTool({
      name: 'search',
      arguments: { query: 'known' },
    });
    assert.ok(JSON.stringify(result.content).includes('known passage'));
  } finally {
    await client.close();
  }
});
