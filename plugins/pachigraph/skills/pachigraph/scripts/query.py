#!/usr/bin/env python3
"""Query the configured Pachigraph history API without exposing credentials."""

import argparse
import json
import os
import stat
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit, urlunsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler

DEFAULT_BASE_URL = "https://pachigraph.djh00t.chatgpt.site"


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def endpoint(value):
    parsed = urlsplit(value)
    if (parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username
            or parsed.password or parsed.fragment or parsed.query or parsed.path not in ("", "/")):
        raise ValueError("endpoint must be an absolute URL without credentials or fragments")
    host = parsed.hostname or ""
    loopback = host == "localhost" or host == "127.0.0.1" or host == "::1"
    if parsed.scheme != "https" and not loopback:
        raise ValueError("non-loopback endpoints must use HTTPS")
    return urlunsplit((parsed.scheme, parsed.netloc, "", "", ""))


def token_from(path):
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(path, flags)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
                raise ValueError("token file must be a regular file owned by the current user")
            mode = stat.S_IMODE(info.st_mode)
            if mode & 0o077 or not mode & 0o400:
                raise ValueError("token file must be owner-readable with no group/world permissions")
            raw = os.read(fd, 4097)
        finally:
            os.close(fd)
    except ValueError:
        raise
    except (OSError, UnicodeError):
        raise ValueError("token file could not be safely read") from None
    if len(raw) > 4096:
        raise ValueError("token file is too large")
    try:
        token = raw.decode("utf-8").rstrip("\r\n")
    except UnicodeDecodeError:
        raise ValueError("token file is not UTF-8 text") from None
    if "\r" in token or "\n" in token:
        raise ValueError("token file must contain one token line")
    if not token:
        raise ValueError("token file is empty")
    return token


def get(base, token, path, params=None):
    query = "" if not params else "?" + urlencode(params)
    request = Request(base + path + query, headers={"Authorization": "Bearer " + token, "Accept": "application/json"})
    try:
        with build_opener(NoRedirect).open(request, timeout=20) as response:
            return json.load(response)
    except HTTPError as exc:
        raise RuntimeError(f"HTTP request failed ({exc.code})") from None
    except (URLError, TimeoutError, OSError, ValueError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"request failed: {type(exc).__name__}") from None


def main(argv=None):
    """Run a read-only HTTP operation and emit JSON without exposing the key."""
    parser = argparse.ArgumentParser(description="Query Pachigraph history")
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL)
    parser.add_argument("--token-file", required=True)
    sub = parser.add_subparsers(dest="command", required=True)
    search = sub.add_parser("search")
    search.add_argument("query")
    fetch = sub.add_parser("fetch")
    fetch.add_argument("id")
    sub.add_parser("status")
    args = parser.parse_args(argv)
    try:
        base = endpoint(args.base_url)
        token = token_from(args.token_file)
        if args.command == "search":
            result = get(base, token, "/api/search", {"q": args.query})
        elif args.command == "fetch":
            result = get(base, token, "/api/fetch", {"id": args.id})
        else:
            result = get(base, token, "/api/status")
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except (ValueError, RuntimeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
