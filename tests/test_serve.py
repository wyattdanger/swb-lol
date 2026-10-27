"""Spec for the local preview server (tools/serve.py): it must never let a browser cache what it serves."""
import os
import sys
import tempfile
import threading
import unittest
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "tools"))
import serve  # noqa: E402


class PreviewServer(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        with open(os.path.join(self.dir.name, "a.js"), "w") as f:
            f.write("console.log(1)")
        self.server = serve.make_server(0, self.dir.name)  # port 0: any free port
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(lambda: (self.server.shutdown(), self.server.server_close()))
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"

    def test_serves_files_and_tells_browsers_never_to_cache_them(self):
        with urllib.request.urlopen(self.base + "/a.js") as r:
            self.assertEqual(r.read(), b"console.log(1)")
            self.assertEqual(r.headers["Cache-Control"], "no-store")

    def test_edits_show_up_on_the_next_request(self):
        with urllib.request.urlopen(self.base + "/a.js") as r:
            r.read()
        with open(os.path.join(self.dir.name, "a.js"), "w") as f:
            f.write("console.log(2)")
        with urllib.request.urlopen(self.base + "/a.js") as r:
            self.assertEqual(r.read(), b"console.log(2)")

    def test_errors_are_not_cacheable_either(self):
        with self.assertRaises(urllib.error.HTTPError) as cm:
            urllib.request.urlopen(self.base + "/missing.js")
        self.assertEqual(cm.exception.headers["Cache-Control"], "no-store")


if __name__ == "__main__":
    unittest.main()
