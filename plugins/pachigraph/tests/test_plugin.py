import json
import os
import stat
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

ROOT = Path(__file__).parents[1]
SCRIPT = ROOT / "skills/pachigraph/scripts/query.py"


class Handler(BaseHTTPRequestHandler):
    token_seen = None
    paths = []

    def do_GET(self):
        type(self).paths.append(self.path)
        type(self).token_seen = self.headers.get("Authorization")
        if self.path.startswith("/error") or "id=error" in self.path:
            self.send_response(500)
            self.end_headers()
            self.wfile.write(b"secret server response")
            return
        if self.path.startswith("/redirect") or "id=redirect" in self.path:
            self.send_response(302)
            self.send_header("Location", "https://example.com/leak")
            self.end_headers()
            return
        body = {"results": [{"id": "r1", "thread_id": "t1", "timestamp": "now", "text": "found", "citation": "c"}]}
        if self.path.startswith("/api/fetch"):
            body = {"id": "r1", "thread_id": "t1", "timestamp": "now", "text": "full", "record": {"x": 1}, "citation": "c"}
        encoded = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def log_message(self, *_):
        pass


class PluginTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = HTTPServer(("127.0.0.1", 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.url = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def run_query(self, *args, token="secret-token"):
        with tempfile.TemporaryDirectory() as td:
            token_file = Path(td) / "token"
            token_file.write_text(token)
            token_file.chmod(0o600)
            return subprocess.run([sys.executable, str(SCRIPT), "--base-url", self.url, "--token-file", str(token_file), *args], text=True, capture_output=True)

    def test_search_and_fetch_use_bearer_and_encode_query(self):
        result = self.run_query("search", "a/b & c")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["results"][0]["text"], "found")
        self.assertIn("q=a%2Fb+%26+c", Handler.paths[-1])
        self.assertEqual(Handler.token_seen, "Bearer secret-token")

        result = self.run_query("fetch", "r1")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["record"], {"x": 1})

    def test_rejects_insecure_non_loopback_and_bad_token_permissions(self):
        with tempfile.TemporaryDirectory() as td:
            token = Path(td) / "token"
            token.write_text("secret")
            token.chmod(0o644)
            result = subprocess.run([sys.executable, str(SCRIPT), "--base-url", "https://example.com", "--token-file", str(token), "search", "x"], text=True, capture_output=True)
            self.assertNotEqual(result.returncode, 0)

            for bad_url in ("https:///foo", "https://example.com/path", "https://example.com/?q=x"):
                result = subprocess.run([sys.executable, str(SCRIPT), "--base-url", bad_url, "--token-file", str(token), "search", "x"], text=True, capture_output=True)
                self.assertNotEqual(result.returncode, 0)

            token.chmod(0o600)
            token.write_text("two\nlines")
            result = subprocess.run([sys.executable, str(SCRIPT), "--base-url", self.url, "--token-file", str(token), "search", "x"], text=True, capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn("secret", result.stderr)
            token.chmod(0o600)
            result = subprocess.run([sys.executable, str(SCRIPT), "--base-url", "http://example.com", "--token-file", str(token), "search", "x"], text=True, capture_output=True)
            self.assertNotEqual(result.returncode, 0)

    def test_http_error_is_sanitized(self):
        result = self.run_query("search", "x")
        self.assertEqual(result.returncode, 0)
        result = self.run_query("fetch", "error")
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("secret server response", result.stderr)

    def test_redirect_is_rejected_without_leaking_token(self):
        result = self.run_query("fetch", "redirect")
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("secret-token", result.stderr)

    def test_manifests_match_official_contract(self):
        plugin = json.loads((ROOT / "plugin.json").read_text())
        mcp = json.loads((ROOT / "mcp.json").read_text())
        self.assertEqual(plugin["$schema"], "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json")
        self.assertEqual(set(plugin), {"$schema", "name", "version", "description", "author", "keywords"})
        self.assertEqual(plugin["name"], "pachigraph")
        self.assertEqual(plugin["version"], "0.1.0")
        self.assertEqual(plugin["author"], {"name": "djh00t"})
        self.assertEqual(mcp["$schema"], "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json")
        self.assertEqual(set(mcp), {"$schema", "mcpServers"})
        server = mcp["mcpServers"]["pachigraph"]
        self.assertEqual(server, {"type": "streamable-http", "url": "https://pachigraph.djh00t.chatgpt.site/mcp"})

        codex = json.loads((ROOT / ".codex-plugin/plugin.json").read_text())
        self.assertNotIn("mcpServers", codex)
        self.assertFalse((ROOT / ".mcp.json").exists())
        self.assertEqual(codex["interface"]["capabilities"], ["Read"])
        self.assertEqual(codex["interface"]["defaultPrompt"], ["Find relevant evidence in my Pachigraph history."])


if __name__ == "__main__":
    unittest.main()
