import http.client
import socket
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _path  # noqa: E402,F401

from causalweb.server import GraphServer  # noqa: E402

GOOD = "nodes:\n  - name: a\n  - name: b\n    caused_by: [a]\n"
BROKEN = "nodes: [\n"
WARNED = "nodes:\n  - name: a\n  - name: b\n    caused_by: [a, ghost]\n"


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.file = Path(self.tmp.name) / "g.yaml"
        self.file.write_text(GOOD, encoding="utf-8")
        self.server = GraphServer(self.file, port=0, quiet=True)
        self.server.start()
        self.host, self.port = self.server.httpd.server_address[:2]

    def tearDown(self):
        self.server.stop()
        self.tmp.cleanup()

    def get(self, path):
        conn = http.client.HTTPConnection(self.host, self.port, timeout=5)
        conn.request("GET", path)
        resp = conn.getresponse()
        body = resp.read().decode("utf-8")
        conn.close()
        return resp.status, body

    def write(self, text):
        # a coarse mtime would hide a quick rewrite; size changes too, which the
        # stamp also includes, but wait a little so this is not timing-dependent
        time.sleep(0.05)
        self.file.write_text(text, encoding="utf-8")

    def wait_for(self, pred, timeout=5):
        deadline = time.time() + timeout
        while time.time() < deadline:
            if pred():
                return True
            time.sleep(0.1)
        return False

    def test_page_and_assets(self):
        status, body = self.get("/")
        self.assertEqual(status, 200)
        self.assertIn('class="causal-graph-data"', body)
        self.assertIn('"id":"b"', body)
        self.assertIn("EventSource", body)
        self.assertNotIn("cg-banner", body)
        for name in ("causalweb.css", "causalweb_query.js", "causalweb.js"):
            status, body = self.get("/static/" + name)
            self.assertEqual(status, 200, name)
        self.assertEqual(self.get("/static/../model.py")[0], 404)
        self.assertEqual(self.get("/nope")[0], 404)
        status, body = self.get("/graph.json")
        self.assertEqual(status, 200)
        self.assertIn('"nodes"', body)

    def test_problems_and_errors_are_shown(self):
        self.write(WARNED)
        self.assertTrue(self.wait_for(lambda: "ghost" in self.get("/")[1]))
        body = self.get("/")[1]
        self.assertIn("cg-banner-warn", body)
        self.assertIn('"id":"b"', body)

        self.write(BROKEN)
        self.assertTrue(self.wait_for(lambda: "cg-banner-error" in self.get("/")[1]))
        body = self.get("/")[1]
        self.assertIn("last version that loaded", body)
        self.assertIn('"id":"b"', body)          # the last good graph stays up

        self.write(GOOD)
        self.assertTrue(self.wait_for(lambda: "cg-banner" not in self.get("/")[1]))

    def test_default_port_falls_back_when_taken(self):
        from causalweb import server as srv
        taken = socket.socket()
        taken.bind(("127.0.0.1", 0))
        taken.listen(1)
        busy = taken.getsockname()[1]
        saved = srv.DEFAULT_PORT
        srv.DEFAULT_PORT = busy
        try:
            other = GraphServer(self.file, quiet=True)      # port left unset
            try:
                self.assertEqual(other.httpd.server_address[1], busy + 1)
            finally:
                other.stop()
            with self.assertRaises(OSError):
                GraphServer(self.file, port=busy, quiet=True)  # explicit: strict
        finally:
            srv.DEFAULT_PORT = saved
            taken.close()

    def test_events_announce_a_change(self):
        sock = socket.create_connection((self.host, self.port), timeout=10)
        sock.sendall(b"GET /events HTTP/1.1\r\nHost: x\r\n\r\n")
        buf = b""
        while b"data: version" not in buf:
            buf += sock.recv(4096)
        self.assertIn(b"text/event-stream", buf)
        self.write(GOOD + "  - name: c\n")
        while b"data: reload" not in buf:
            chunk = sock.recv(4096)
            if not chunk:
                break
            buf += chunk
        sock.close()
        self.assertIn(b"data: reload", buf)
        self.assertTrue(self.wait_for(lambda: '"id":"c"' in self.get("/")[1]))


if __name__ == "__main__":
    unittest.main()
