import http.client
import socket
import time

import pytest

from causalweb import server as srv
from causalweb.server import GraphServer

GOOD = "nodes:\n  - name: a\n  - name: b\n    caused_by: [a]\n"
BROKEN = "nodes: [\n"
WARNED = "nodes:\n  - name: a\n  - name: b\n    caused_by: [a, ghost]\n"


class Running:
    """A server on a temporary graph file, and helpers to talk to it."""

    def __init__(self, file):
        self.file = file
        self.file.write_text(GOOD, encoding="utf-8")
        self.server = GraphServer(self.file, port=0, quiet=True)
        self.server.start()
        self.host, self.port = self.server.httpd.server_address[:2]

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


def wait_for(pred, timeout=5):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if pred():
            return True
        time.sleep(0.1)
    return False


@pytest.fixture
def running(tmp_path):
    r = Running(tmp_path / "g.yaml")
    yield r
    r.server.stop()


def test_page_and_assets(running):
    status, body = running.get("/")
    assert status == 200
    assert 'class="causal-graph-data"' in body
    assert '"id":"b"' in body
    assert "EventSource" in body
    assert "cg-banner" not in body
    for name in ("causalweb.css", "causalweb_query.js", "causalweb.js"):
        status, body = running.get("/static/" + name)
        assert status == 200, name
    assert running.get("/static/../model.py")[0] == 404
    assert running.get("/nope")[0] == 404
    status, body = running.get("/graph.json")
    assert status == 200
    assert '"nodes"' in body


def test_problems_and_errors_are_shown(running):
    running.write(WARNED)
    assert wait_for(lambda: "ghost" in running.get("/")[1])
    body = running.get("/")[1]
    assert "cg-banner-warn" in body
    assert '"id":"b"' in body

    running.write(BROKEN)
    assert wait_for(lambda: "cg-banner-error" in running.get("/")[1])
    body = running.get("/")[1]
    assert "last version that loaded" in body
    assert '"id":"b"' in body          # the last good graph stays up

    running.write(GOOD)
    assert wait_for(lambda: "cg-banner" not in running.get("/")[1])


def test_default_port_falls_back_when_taken(running, monkeypatch):
    taken = socket.socket()
    taken.bind(("127.0.0.1", 0))
    taken.listen(1)
    busy = taken.getsockname()[1]
    monkeypatch.setattr(srv, "DEFAULT_PORT", busy)
    try:
        other = GraphServer(running.file, quiet=True)      # port left unset
        try:
            assert other.httpd.server_address[1] == busy + 1
        finally:
            other.stop()
        with pytest.raises(OSError):
            GraphServer(running.file, port=busy, quiet=True)  # explicit: strict
    finally:
        taken.close()


def test_events_announce_a_change(running):
    sock = socket.create_connection((running.host, running.port), timeout=10)
    sock.sendall(b"GET /events HTTP/1.1\r\nHost: x\r\n\r\n")
    buf = b""
    while b"data: version" not in buf:
        buf += sock.recv(4096)
    assert b"text/event-stream" in buf
    running.write(GOOD + "  - name: c\n")
    while b"data: reload" not in buf:
        chunk = sock.recv(4096)
        if not chunk:
            break
        buf += chunk
    sock.close()
    assert b"data: reload" in buf
    assert wait_for(lambda: '"id":"c"' in running.get("/")[1])
