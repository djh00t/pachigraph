"""Exercise generated keys against loopback Workers; never use real credentials."""

import hashlib
import json
import urllib.error
import urllib.request
import uuid

owner = "synthetic-key-" + str(uuid.uuid4())
thread = str(uuid.uuid4())
created = []


def call(path, method="GET", body=None, key=None, human=False, expected=200):
    headers = {
        "content-type": "application/json",
        "accept": "application/json, text/event-stream",
    }
    if human:
        headers.update(
            {
                "oai-authenticated-user-id": owner,
                "oai-authenticated-user-email": "test@example.invalid",
            }
        )
    if key:
        headers["authorization"] = "Bearer " + key
    request = urllib.request.Request(
        "http://127.0.0.1:8787" + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers=headers,
        method=method,
    )
    try:
        response = urllib.request.urlopen(request, timeout=15)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        assert response.status == expected, (path, response.status, expected)
        data = response.read()
    return json.loads(data) if data else None


try:
    call("/api/keys", expected=401)
    for scope in ["read", "ingest"]:
        created.append(
            call("/api/keys", "POST", {"scope": scope, "days": 1}, human=True)
        )
    read, ingest = [item["key"] for item in created]
    record = {
        "thread_id": thread,
        "records": [
            {
                "id": hashlib.sha256(b"synthetic-event").hexdigest(),
                "timestamp": "2026-09-05T00:00:00Z",
                "text": "keyverificationpassage",
                "record": {"text": "keyverificationpassage"},
            }
        ],
    }
    assert call("/api/ingest", "POST", record, key=ingest) == {
        "stored": 1,
        "duplicate": 0,
    }
    assert call("/api/ingest", "POST", record, key=ingest) == {
        "stored": 0,
        "duplicate": 1,
    }
    found = call("/api/search?q=keyverificationpassage", key=read)["results"]
    assert len(found) == 1
    assert call("/api/fetch?id=" + found[0]["id"], key=read)["thread_id"] == thread
    call("/api/search?q=keyverificationpassage", key=ingest, expected=403)
    call("/api/ingest", "POST", record, key=read, expected=403)
    call("/api/keys", key=read, expected=401)
    initialized = call(
        "/mcp",
        "POST",
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-03-26",
                "capabilities": {},
                "clientInfo": {"name": "synthetic-smoke", "version": "1"},
            },
        },
        key=read,
    )
    assert initialized["result"]["serverInfo"]["name"] == "pachigraph"
    tools = call(
        "/mcp",
        "POST",
        {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}},
        key=read,
    )
    assert {tool["name"] for tool in tools["result"]["tools"]} == {"search", "fetch"}
    result = call(
        "/mcp",
        "POST",
        {
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": {
                "name": "search",
                "arguments": {"query": "keyverificationpassage"},
            },
        },
        key=read,
    )
    assert not result["result"].get("isError")
    evidence = json.loads(result["result"]["content"][0]["text"])
    assert evidence["results"][0]["id"] == found[0]["id"]
    call("/api/keys?id=" + created[0]["id"], "DELETE", human=True)
    call("/api/search?q=keyverificationpassage", key=read, expected=401)
    call(
        "/mcp",
        "POST",
        {"jsonrpc": "2.0", "id": 4, "method": "tools/list"},
        key=read,
        expected=401,
    )
    print(
        "PASS: generated keys, ingest/replay, search/fetch, scope enforcement, MCP lifecycle/search and revocation"
    )
finally:
    for item in created:
        call("/api/keys?id=" + item["id"], "DELETE", human=True)
    call("/api/thread?id=" + thread, "DELETE", human=True)
    assert call("/api/keys", human=True) == []
    print("PASS: synthetic keys and source records removed; credentials not printed")
