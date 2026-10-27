#!/usr/bin/env python3
"""Local preview server: like `python3 -m http.server`, plus `Cache-Control: no-store`.

Plain http.server sends no cache headers, so Safari (and others) can keep showing an old script or stylesheet
after you edit it. With no-store a normal reload always shows your latest edits.

Usage: python3 tools/serve.py [port]    # serves the repo root at http://127.0.0.1:<port>/ (default 8000)
"""
import functools
import http.server
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def make_server(port=8000, directory=ROOT):
    handler = functools.partial(NoCacheHandler, directory=directory)
    return http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    print(f"serving {ROOT} at http://127.0.0.1:{port}/ (no caching)", flush=True)
    make_server(port).serve_forever()
