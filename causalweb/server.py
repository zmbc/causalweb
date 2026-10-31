"""A local server that shows one graph and reloads the page when its file changes.

The page is the same whole-window page the Sphinx build writes, plus a banner
for validation problems and a few lines of script that listen on ``/events``.
The server polls the graph file and the viewer assets for changes; on one it
re-reads the graph and tells every open page to reload. A file that no longer
parses keeps the last good graph on screen under an error banner, so a typo
mid-edit never leaves a blank page.
"""

from __future__ import annotations

import sys
import threading
import time
import webbrowser
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from .model import CausalGraph, GraphError, load_graph
from .page import ASSETS, STATIC_DIR, asset_fingerprint, banner_html, page_html

POLL_SECONDS = 0.5
KEEPALIVE_SECONDS = 15
DEFAULT_PORT = 8765
# How many ports above the default to try when it is taken. Shared machines
# have other people's servers on them, and a dev tool should not stop for that.
PORT_TRIES = 20
CONTENT_TYPES = {".css": "text/css", ".js": "application/javascript"}


@dataclass
class Snapshot:
    graph: CausalGraph | None
    problems: list[str]
    error: str | None
    version: int
    fingerprint: str


class GraphState:
    """The graph as last loaded, and a version that changes when it does."""

    def __init__(self, path: Path):
        self.path = Path(path).resolve()
        self._cond = threading.Condition()
        self._stamp: tuple | None = None
        self.version = 0
        self.graph: CausalGraph | None = None
        self.problems: list[str] = []
        self.error: str | None = None
        self.fingerprint = ""
        self.refresh(force=True)

    def _watched(self) -> tuple:
        files = [self.path] + [STATIC_DIR / name for name in ASSETS]
        files += sorted(Path(__file__).parent.glob("*.py"))
        out = []
        for f in files:
            try:
                st = f.stat()
                out.append((str(f), st.st_mtime_ns, st.st_size))
            except OSError:
                out.append((str(f), None, None))
        return tuple(out)

    def refresh(self, force: bool = False) -> bool:
        """Re-read the graph if anything watched has changed. True if it did."""
        stamp = self._watched()
        with self._cond:
            if not force and stamp == self._stamp:
                return False
            self._stamp = stamp
            try:
                graph = load_graph(self.path)
            except GraphError as exc:
                self.error = str(exc)
            except Exception as exc:  # never let the server die on a bad file
                self.error = f"{type(exc).__name__}: {exc}"
            else:
                self.graph = graph
                self.problems = list(graph.problems)
                self.error = None
            self.fingerprint = asset_fingerprint()
            self.version += 1
            self._cond.notify_all()
            return True

    def snapshot(self) -> Snapshot:
        with self._cond:
            return Snapshot(self.graph, list(self.problems), self.error,
                            self.version, self.fingerprint)

    def wait_for_change(self, since: int, timeout: float) -> int:
        """Block until the version differs from ``since`` or ``timeout`` passes."""
        with self._cond:
            if self.version == since:
                self._cond.wait(timeout)
            return self.version

    def watch(self, stop: threading.Event) -> None:
        while not stop.is_set():
            try:
                self.refresh()
            except Exception as exc:  # pragma: no cover - defensive
                print(f"causalweb: watcher error: {exc!r}", file=sys.stderr)
            stop.wait(POLL_SECONDS)


def make_handler(state: GraphState, group: str | None, collapse: int | None,
                 title: str, quiet: bool):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *args):
            if not quiet:
                super().log_message(fmt, *args)

        def _send(self, status: int, body: bytes, content_type: str) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def do_HEAD(self):
            self.do_GET()

        def do_GET(self):
            path = urlsplit(self.path).path
            if path in ("/", "/index.html"):
                self._page()
            elif path == "/events":
                self._events()
            elif path == "/graph.json":
                self._graph_json()
            elif path.startswith("/static/"):
                self._static(path[len("/static/"):])
            else:
                self._send(HTTPStatus.NOT_FOUND, b"not found", "text/plain")

        def _page(self):
            snap = state.snapshot()
            problems = list(snap.problems)
            payload = None
            if snap.graph is not None:
                if group and group not in snap.graph.groups:
                    problems.insert(0, f"unknown group {group!r}; showing the whole graph")
                    payload = snap.graph.payload(None)
                else:
                    payload = snap.graph.payload(group)
            banner = banner_html(problems, snap.error, state.path.name)
            body = page_html(payload, collapse=collapse, title=title,
                             asset_base="static/", fingerprint=snap.fingerprint,
                             banner=banner, live_version=snap.version)
            self._send(HTTPStatus.OK, body.encode("utf-8"), "text/html; charset=utf-8")

        def _graph_json(self):
            snap = state.snapshot()
            if snap.graph is None:
                self._send(HTTPStatus.SERVICE_UNAVAILABLE,
                           (snap.error or "no graph").encode("utf-8"), "text/plain")
                return
            body = snap.graph.payload(group if group in snap.graph.groups else None)
            self._send(HTTPStatus.OK, body.encode("utf-8"), "application/json")

        def _static(self, name: str):
            if name not in ASSETS:
                self._send(HTTPStatus.NOT_FOUND, b"not found", "text/plain")
                return
            path = STATIC_DIR / name
            try:
                body = path.read_bytes()
            except OSError:
                self._send(HTTPStatus.NOT_FOUND, b"not found", "text/plain")
                return
            self._send(HTTPStatus.OK, body,
                       CONTENT_TYPES.get(path.suffix, "application/octet-stream"))

        def _events(self):
            """Server-sent events: the current version, then ``reload`` on change.

            Each open page holds one of these connections, and one thread of
            the server with it, which is fine for a local tool.
            """
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "keep-alive")
            self.end_headers()
            version = state.version
            try:
                self._event(f"version {version}")
                while True:
                    newer = state.wait_for_change(version, KEEPALIVE_SECONDS)
                    if newer != version:
                        self._event("reload")
                        return
                    self.wfile.write(b": keepalive\n\n")
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, OSError):
                return

        def _event(self, data: str) -> None:
            self.wfile.write(f"data: {data}\n\n".encode("utf-8"))
            self.wfile.flush()

    return Handler


class GraphServer:
    """The server and its file watcher, started together and stopped together."""

    def __init__(self, path: Path, *, group: str | None = None,
                 collapse: int | None = None, host: str = "127.0.0.1",
                 port: int | None = None, title: str | None = None,
                 quiet: bool = False):
        """``port`` None tries the default and the ports just above it; a
        number is used as given, so 0 asks the system for any free port."""
        self.state = GraphState(path)
        self.group = group
        self.collapse = collapse
        title = title or f"{self.state.path.name} — causal graph"
        handler = make_handler(self.state, group, collapse, title, quiet)
        self.httpd = self._listen(host, port, handler)
        self.httpd.daemon_threads = True
        self._stop = threading.Event()
        self._watcher = threading.Thread(target=self.state.watch, args=(self._stop,),
                                         daemon=True)
        self._server_thread: threading.Thread | None = None
        self._serving = False

    @staticmethod
    def _listen(host: str, port: int | None, handler) -> ThreadingHTTPServer:
        if port is not None:
            return ThreadingHTTPServer((host, port), handler)
        last: OSError | None = None
        for candidate in range(DEFAULT_PORT, DEFAULT_PORT + PORT_TRIES):
            try:
                return ThreadingHTTPServer((host, candidate), handler)
            except OSError as exc:
                last = exc
        raise OSError(
            f"ports {DEFAULT_PORT}-{DEFAULT_PORT + PORT_TRIES - 1} are all in use"
            f" ({last}); pass --port 0 for any free port"
        )

    @property
    def url(self) -> str:
        host, port = self.httpd.server_address[:2]
        return f"http://{host}:{port}/"

    def start(self) -> None:
        """Run in the background, for tests and embedding."""
        self._watcher.start()
        self._serving = True
        self._server_thread = threading.Thread(target=self.httpd.serve_forever,
                                               daemon=True)
        self._server_thread.start()

    def serve_forever(self) -> None:
        """Run in the foreground until interrupted."""
        self._watcher.start()
        self._serving = True
        try:
            self.httpd.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            self.stop()

    def stop(self) -> None:
        self._stop.set()
        # shutdown() waits for serve_forever() to return, so on a server that
        # was never started it would wait forever.
        if self._serving:
            self.httpd.shutdown()
            self._serving = False
        self.httpd.server_close()


def serve(path: Path, *, group: str | None = None, collapse: int | None = None,
          host: str = "127.0.0.1", port: int | None = None,
          open_browser: bool = False, quiet: bool = False) -> int:
    """Serve ``path`` until interrupted. Returns a process exit code."""
    try:
        server = GraphServer(path, group=group, collapse=collapse, host=host,
                             port=port, quiet=quiet)
    except OSError as exc:
        where = f"{host}:{port}" if port is not None else host
        print(f"causalweb: could not listen on {where}: {exc}", file=sys.stderr)
        return 1
    snap = server.state.snapshot()
    # Flushed, so the address shows up at once even when stdout is a pipe.
    print(f"Serving {server.state.path}", flush=True)
    print(f"  at {server.url}  (Ctrl-C to stop)", flush=True)
    if snap.error:
        print(f"  the file did not load: {snap.error}", file=sys.stderr, flush=True)
    for problem in snap.problems:
        print(f"  problem: {problem}", file=sys.stderr, flush=True)
    if open_browser:
        webbrowser.open(server.url)
    server.serve_forever()
    return 0
