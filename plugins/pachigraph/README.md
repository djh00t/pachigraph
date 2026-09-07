# Pachigraph plugin

This package provides a portable Agent Skill with Python HTTP tools. It supports
the Agent Plugins 1.0 and Codex layouts, and can also be installed as a standalone
skill. No MCP server registration is required.

Generate a read key from the signed-in
[`/keys`](https://pachigraph.e164sip.com/keys) page.

## Install the skill

Copy `skills/pachigraph/` into your agent's skill directory. For Codex, use
`~/.codex/skills/pachigraph/` (or `$CODEX_HOME/skills/pachigraph/`). Keep its
`SKILL.md` and `scripts/query.py` together. Invoke `$pachigraph` in a task and
provide the key-file path, never the key value. The agent must have a shell tool
and permission to reach the configured HTTPS API.

Clients supporting Agent Plugins can load this package's `plugin.json` and
`skills/`; Codex plugin clients can use `.codex-plugin/plugin.json`. Neither
manifest contains credentials or a remote tool-server configuration.

## HTTP CLI

Save the key as one UTF-8 line in a file owned by the current user with no group
or world permissions, then run:

```sh
chmod 600 /absolute/path/to/key
python3 skills/pachigraph/scripts/query.py \
  --token-file /absolute/path/to/key search 'query terms'
python3 skills/pachigraph/scripts/query.py \
  --token-file /absolute/path/to/key fetch RECORD_ID
python3 skills/pachigraph/scripts/query.py \
  --token-file /absolute/path/to/key status
```

The CLI uses only Python's standard library, rejects redirects, and accepts
plain HTTP only for loopback testing.

The commands call `/api/search`, `/api/fetch`, and `/api/status` with the read
key. `status.text_bytes` measures indexed text only, not allocated PostgreSQL storage.
The collector retains its separate ingest key. Live HTTP gateway qualification
is still required; installing the skill does not change ingress access controls.

## MCP clients

The Kubernetes application also serves Streamable HTTP at
`https://pachigraph.e164sip.com/mcp` with the same read key in an Authorization
Bearer header. It exposes `search`, `fetch` and `status`. Store the header using
your client's secret facility; the portable skill manifests remain HTTP-only.
The new endpoint requires deployment and live qualification before use.
