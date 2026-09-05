"""Exercise generated keys against loopback Workers; never use real credentials."""

import hashlib
import json
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
import uuid
from pathlib import Path

owner = "synthetic-key-" + str(uuid.uuid4())
thread = str(uuid.uuid4())
created = []


def call(path, method="GET", body=None, key=None, human=False, expected=200):
    headers = {
        "content-type": "application/json",
        "accept": "application/json",
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


def query(*args, key, expected=0):
    """Exercise the shipped skill tool with an owner-only synthetic key file."""
    script = Path(__file__).parents[1] / "plugins/pachigraph/skills/pachigraph/scripts/query.py"
    with tempfile.TemporaryDirectory() as directory:
        token_file = Path(directory) / "key"
        token_file.write_text(key)
        token_file.chmod(0o600)
        result = subprocess.run(
            [sys.executable, str(script), "--base-url", "http://127.0.0.1:8787",
             "--token-file", str(token_file), *args],
            text=True, capture_output=True, timeout=25,
        )
    assert result.returncode == expected, result.stderr
    assert key not in result.stdout + result.stderr
    return json.loads(result.stdout) if result.stdout else None


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
    evidence = query("search", "keyverificationpassage", key=read)["results"]
    assert evidence == found
    fetched = query("fetch", evidence[0]["id"], key=read)
    assert fetched["thread_id"] == thread
    assert fetched["citation"] == evidence[0]["citation"]
    status = query("status", key=read)
    assert status["threads"] == 1 and status["records"] == 1
    query("status", key=ingest, expected=2)
    call("/api/keys?id=" + created[0]["id"], "DELETE", human=True)
    call("/api/search?q=keyverificationpassage", key=read, expected=401)
    query("status", key=read, expected=2)
    print(
        "PASS: generated keys, ingest/replay, HTTP skill search/fetch/status, scope enforcement and revocation"
    )
finally:
    for item in created:
        call("/api/keys?id=" + item["id"], "DELETE", human=True)
    call("/api/thread?id=" + thread, "DELETE", human=True)
    assert call("/api/keys", human=True) == []
    print("PASS: synthetic keys and source records removed; credentials not printed")
