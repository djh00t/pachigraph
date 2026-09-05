# Pachigraph plugin

This package supports the portable Agent Plugins 1.0 layout and Codex. Its MCP
and HTTP endpoints are read-only when used with an owner-generated read key.

Generate a read key from the signed-in
[`/keys`](https://pachigraph.djh00t.chatgpt.site/keys) page.

## Codex MCP

Put the key in the `PACHIGRAPH_API_KEY` environment variable using your normal
secret manager or shell startup configuration. Register the remote server with
the environment variable name; the command does not contain the key:

```sh
codex mcp add pachigraph \
  --url https://pachigraph.djh00t.chatgpt.site/mcp \
  --bearer-token-env-var PACHIGRAPH_API_KEY
```

Restart Codex, then inspect the connection with `codex mcp get pachigraph` or
`/mcp`. The Codex plugin manifest intentionally packages the skill only: the
supported environment-backed Bearer setting belongs in the user's MCP config.

## Portable Agent Plugins clients

`plugin.json`, `mcp.json`, and `skills/` form the portable package. Agent
Plugins 1.0 does not define a portable credential-reference field, so configure
your client to send the read key as `Authorization: Bearer <key>`. Do not add it
to either manifest.

## HTTP CLI

Save the key as one UTF-8 line in a file owned by the current user with no group
or world permissions, then run:

```sh
chmod 600 /absolute/path/to/key
python3 skills/pachigraph/scripts/query.py \
  --token-file /absolute/path/to/key search 'query terms'
python3 skills/pachigraph/scripts/query.py \
  --token-file /absolute/path/to/key fetch RECORD_ID
```

The CLI uses only Python's standard library, rejects redirects, and accepts
plain HTTP only for loopback testing.
