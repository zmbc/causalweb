"""Drive the viewer in headless Chromium.

Skipped when Playwright or a launchable browser is missing. On a machine with
no system fonts or Chromium libraries, point the browser at them first, for
example::

    LD_LIBRARY_PATH=/path/to/libs FONTCONFIG_FILE=/path/to/fonts.conf \\
        python -m pytest tests/test_ui.py

The environment is passed through to the browser process as is.
"""

import os
import time
from pathlib import Path

import pytest

from causalweb.page import STATIC_DIR
from causalweb.server import GraphServer

try:
    from playwright.sync_api import sync_playwright
except ImportError:  # pragma: no cover
    sync_playwright = None

NESTED = Path(__file__).resolve().parent / "nested.yaml"

SMALL = """
level_labels: [phase]
groups:
  - name: early
    contains: [a, b, inner]
  - name: late
    contains: [d, e]
  - name: inner
    contains: [c]
nodes:
  - name: a
  - name: b
    caused_by: [a]
  - name: c
    caused_by: [b]
    deterministic: true
  - name: d
    label: Shared name
    caused_by: [c, x]
    kind: outcome
  - name: e
    label: Shared name
    caused_by: [d]
  - name: x
correlated:
  - [a, x]
"""

# Collapsed, g and h cause each other: a -> b -> c with b in h, a and c in g.
CYCLIC = """
groups:
  - name: g
    contains: [a, c]
  - name: h
    contains: [b]
nodes:
  - name: a
  - name: b
    caused_by: [a]
  - name: c
    caused_by: [b]
"""

# Collapsed, g has two edges into h, so its matrix cell shows "2".
DOUBLE = """
groups:
  - name: g
    contains: [a, b]
  - name: h
    contains: [c]
nodes:
  - name: a
  - name: b
  - name: c
    caused_by: [a, b]
"""

# The visible entries of the diagram's legend and the matrix's legend.
LEGENDS = """(() => {
  function entries(legend) {
    if (!legend) return null;
    return Array.from(legend.children).filter(s => !s.hidden).map(s =>
      Array.from(s.childNodes).filter(n => n.nodeType === 3 || !n.hidden)
        .map(n => n.textContent.trim()).filter(Boolean).join(" "));
  }
  return {
    graph: entries(document.querySelector(".cg-graph .causal-graph-legend:not([hidden])")),
    matrix: entries(document.querySelector(".cg-matrix .causal-graph-legend:not([hidden])")),
  };
})()"""

READY = ("(() => { var c = document.querySelector('.causal-graph');"
         " return !!(c && c._cyForTest); })()")


class Viewer:
    """Opens pages in the shared browser and records their errors."""

    def __init__(self, browser, url):
        self.browser = browser
        self.url = url
        self.errors = []
        self.servers = []

    def open(self, url=None):
        page = self.browser.new_page(viewport={"width": 1400, "height": 800})
        self.errors = []
        page.on("pageerror", lambda e: self.errors.append(str(e)))
        page.goto(url or self.url)
        ready(page)
        return page

    def open_graph(self, path):
        """Serve another graph file for one test, and open it."""
        server = GraphServer(path, port=0, quiet=True)
        server.start()
        self.servers.append(server)
        return self.open(server.url)

    def close(self):
        for server in self.servers:
            server.stop()


@pytest.fixture(scope="module")
def browser():
    if sync_playwright is None:
        pytest.skip("Playwright is not installed")
    with sync_playwright() as pw:
        try:
            b = pw.chromium.launch(env=dict(os.environ), args=["--no-sandbox"])
        except Exception as e:
            pytest.skip("Chromium cannot start: " + str(e).splitlines()[0])
        yield b
        b.close()


@pytest.fixture(scope="module")
def small_file(tmp_path_factory):
    path = tmp_path_factory.mktemp("ui") / "small.yaml"
    path.write_text(SMALL, encoding="utf-8")
    return path


@pytest.fixture(scope="module")
def small_server(small_file):
    server = GraphServer(small_file, port=0, quiet=True)
    server.start()
    yield server
    server.stop()


@pytest.fixture
def viewer(browser, small_server):
    v = Viewer(browser, small_server.url)
    yield v
    v.close()


def ready(page):
    page.wait_for_function(READY, timeout=60000)
    time.sleep(0.3)


def click(page, name):
    page.get_by_role("button", name=name, exact=True).click()
    ready(page)


def state(page):
    return page.evaluate("""(() => {
      var c = document.querySelector('.causal-graph');
      var cy = c._cyForTest, mx = c._matrixForTest;
      var t = document.querySelector('table.cg-mx');
      return {
        nodes: cy.nodes().filter(n => !n.data('isBox')).map(n => n.id()).sort(),
        boxes: cy.nodes('[isBox = 1]').length,
        hash: location.hash,
        matrix: !document.querySelector('.cg-matrix').hidden,
        order: mx ? mx.order : null,
        direct: t ? Array.from(t.querySelectorAll('td.cg-mx-direct'))
                     .map(td => [td.getAttribute('data-s'), td.getAttribute('data-t')]) : [],
        reach: t ? t.querySelectorAll('td.cg-mx-reach').length : 0,
        corr: t ? t.querySelectorAll('td.cg-mx-corr').length : 0,
        panelHidden: document.querySelector('.causal-graph-panel').hidden,
      };
    })()""")


def assert_routed(page):
    # ELK's routes reach the edges as geometry measured from the endpoints;
    # the stylesheet's bezier, or the straight placeholder drawn while a
    # tween runs, measure from the intersection instead. So wait for the
    # tween first.
    page.wait_for_function(
        "document.querySelector('.causal-graph')._cyForTest.nodes()"
        ".filter(n => n.animated()).length === 0", timeout=10000)
    time.sleep(0.2)
    styles = page.evaluate(
        "document.querySelector('.causal-graph')._cyForTest.edges()"
        ".map(e => [e.style('curve-style'), e.style('edge-distances')])")
    assert styles
    for curve, distances in styles:
        assert curve in ("segments", "round-segments", "straight")
        assert distances == "endpoints"


def test_presets_and_matrix(viewer):
    page = viewer.open()
    st = state(page)
    assert st["nodes"] == ["a", "b", "c", "d", "e", "x"]
    assert st["boxes"] == 3
    assert st["matrix"]

    click(page, "By phase")
    st = state(page)
    assert st["nodes"] == ["g:early", "g:late", "x"]
    assert st["hash"] == "#open="
    assert st["matrix"]
    # x causes d, which is in `late`, so x sits between the two groups
    assert st["order"] == ["g:early", "x", "g:late"]
    assert sorted(st["direct"]) == [["g:early", "g:late"], ["x", "g:late"]]
    assert st["corr"] == 2

    click(page, "Every variable")
    st = state(page)
    pos = {b: i for i, b in enumerate(st["order"])}
    for s, t in st["direct"]:
        assert pos[s] < pos[t]
    assert len(st["direct"]) == 5
    assert st["reach"] > 0
    assert_routed(page)
    assert viewer.errors == []
    page.close()


def test_state_survives_reload(viewer):
    page = viewer.open()
    click(page, "By phase")
    before = state(page)
    page.reload()
    ready(page)
    after = state(page)
    assert after["nodes"] == before["nodes"]
    assert after["matrix"]
    assert after["hash"] == before["hash"]
    page.close()


def test_matrix_hover_and_click(viewer):
    page = viewer.open()
    page.hover('td[data-s="a"][data-t="b"]')
    time.sleep(0.2)
    # both buckets' row and column headers light up
    assert page.evaluate("document.querySelectorAll('th.cg-mx-hl').length") == 4
    assert page.evaluate("document.querySelectorAll('td.cg-mx-hl').length") == 1
    tip = page.evaluate("document.querySelector('.cg-matrix .cg-tip').textContent")
    assert "A → B" in tip
    hovered = page.evaluate(
        "document.querySelector('.causal-graph')._cyForTest.elements('.hovered').map(e => e.id()).sort()")
    assert hovered == ["a", "b", "ea>b"]

    page.click('th.cg-mx-row[data-b="b"]')
    time.sleep(0.2)
    assert page.evaluate("!!document.querySelector('table.cg-mx.cg-mx-focus')")
    picked = page.evaluate(
        "document.querySelector('.causal-graph')._cyForTest.nodes('.picked').map(n => n.id())")
    assert picked == ["b"]

    # a cell between two variables asks the query about them
    page.click('td[data-s="a"][data-t="d"]')
    ready(page)
    st = state(page)
    assert not st["panelHidden"]
    assert "q=a,d" in st["hash"]
    text = page.evaluate("document.querySelector('.causal-graph-panel').textContent")
    assert "A causes Shared name (Late)" in text

    # the matrix stays up, now of the projection. a and x are correlated
    # and x causes d, so x is kept: legs a -> d and x -> d, and a <-> x.
    assert st["matrix"]
    assert st["order"] == ["a", "x", "d"]
    assert sorted(st["direct"]) == [["a", "d"], ["x", "d"]]
    assert st["corr"] == 2
    # clicking the a -> d leg opens it at its waist, b
    page.click('td[data-s="a"][data-t="d"]')
    ready(page)
    st = state(page)
    assert sorted(st["order"]) == ["a", "b", "d", "x"]
    assert sorted(st["direct"]) == [["a", "b"], ["b", "d"], ["x", "d"]]
    assert_routed(page)       # the morph carried the routes over
    # headers say only what they are; the colour carries the role
    page.hover('th.cg-mx-row[data-b="b"]')
    time.sleep(0.2)
    tip = page.evaluate("document.querySelector('.cg-matrix .cg-tip').textContent")
    assert tip == "B"
    contracted = page.evaluate(
        "document.querySelector('.causal-graph')._cyForTest.edges('[contracted = 1]')"
        ".map(e => e.id()).sort()")
    assert contracted == ["pb>d"]
    roles = page.evaluate(
        "(() => { var cy = document.querySelector('.causal-graph')._cyForTest;"
        " var r = {}; cy.nodes().forEach(n => r[n.id()] = n.data('role')); return r; })()")
    assert roles == {"a": "query", "d": "query", "b": "via", "x": "via"}
    # the opened leg is in the fragment and survives a reload
    assert "x=b" in st["hash"]
    page.reload()
    ready(page)
    st = state(page)
    assert sorted(st["order"]) == ["a", "b", "d", "x"]
    # and can be folded back, then opened once more, each a morph that
    # eases edges from values the previous ease left behind
    click(page, "Collapse again")
    assert_routed(page)
    assert sorted(state(page)["order"]) == ["a", "d", "x"]
    page.click('td[data-s="a"][data-t="d"]')
    ready(page)
    assert_routed(page)
    assert sorted(state(page)["order"]) == ["a", "b", "d", "x"]
    assert viewer.errors == []
    page.close()


def test_duplicate_labels_are_told_apart(viewer):
    page = viewer.open()
    click(page, "Query")
    options = page.evaluate(
        "Array.from(document.querySelector('.causal-graph-panel select').options).map(o => o.text)")
    assert options.count("Shared name (Late)") == 2
    page.close()


def test_live_reload(viewer, small_file):
    page = viewer.open()
    count = ("(() => { var c = document.querySelector('.causal-graph');"
             " return c && c._cyForTest &&"
             " c._cyForTest.edges('[kind = \"correlated\"]').length === %d; })()")
    try:
        small_file.write_text(SMALL + "  - [b, x]\n", encoding="utf-8")
        page.wait_for_function(count % 2, timeout=60000)
    finally:
        # the other tests share this file, so it goes back whatever happened
        small_file.write_text(SMALL, encoding="utf-8")
    page.wait_for_function(count % 1, timeout=60000)
    page.close()


def test_nested_matrix_at_every_level(viewer):
    # Every scope in tests/nested.yaml lists its members out of causal order.
    page = viewer.open_graph(NESTED)
    expected = {
        "By stage": ["g:early", "x", "g:late"],
        "By step": ["g:early_one", "e_mid", "g:early_two", "x",
                    "g:late_one", "g:late_two"],
        "Every variable": ["e1a", "e1b", "e_mid", "e2a", "e2b", "x",
                           "l1a", "l1b", "l2b", "l2a"],
    }
    for preset, order in expected.items():
        click(page, preset)
        st = state(page)
        assert st["order"] == order, preset
        pos = {b: i for i, b in enumerate(st["order"])}
        for s, t in st["direct"]:
            assert pos[s] < pos[t], (preset, s, t)
    assert len(st["direct"]) == 11
    assert viewer.errors == []
    page.close()


def test_legends_show_what_is_drawn(viewer, tmp_path):
    page = viewer.open()
    note = "matrix: rows cause columns, in causal order"
    # every variable: no intervention, and every cell counts one edge
    assert page.evaluate(LEGENDS) == {
        "graph": ["deterministic", "outcome", "causes", "correlated"],
        "matrix": ["direct edge", "causal path, no direct edge", "correlated", note],
    }
    # the deterministic variable and the outcome are inside closed groups
    click(page, "By phase")
    assert page.evaluate(LEGENDS) == {
        "graph": ["causes", "correlated"],
        "matrix": ["direct edge", "correlated", note],
    }
    # the answer for a and d: x -> d is an edge, a -> d runs through b and
    # c, and nothing upstream moves both a and d
    click(page, "Every variable")
    page.click('td[data-s="a"][data-t="d"]')
    ready(page)
    assert page.evaluate(LEGENDS) == {
        "graph": ["query variables", "other variables", "causes directly",
                  "causes through hidden variables", "correlated"],
        "matrix": ["direct edge", "path through hidden variables",
                   "shared upstream causes or a correlation",
                   "matrix of the answer: rows cause columns; click a leg to open it"],
    }
    page.close()

    path = tmp_path / "double.yaml"
    path.write_text(DOUBLE, encoding="utf-8")
    page = viewer.open_graph(path)
    assert page.evaluate(LEGENDS)["matrix"] == ["direct edge", note]
    click(page, "Level 1")
    assert page.evaluate(LEGENDS)["matrix"] == [
        "direct edge (a number counts the variable-level edges)", note]
    assert viewer.errors == []
    page.close()


def test_cyclic_collapse_is_flagged(viewer, tmp_path):
    path = tmp_path / "cyclic.yaml"
    path.write_text(CYCLIC, encoding="utf-8")
    page = viewer.open_graph(path)
    click(page, "Level 1")
    mx = page.evaluate(
        "(() => { var mx = document.querySelector('.causal-graph')._matrixForTest;"
        " return {order: mx.order, cyclic: mx.cyclic}; })()")
    assert mx["cyclic"]
    assert sorted(mx["order"]) == ["g:g", "g:h"]
    assert sorted(state(page)["direct"]) == [["g:g", "g:h"], ["g:h", "g:g"]]
    assert viewer.errors == []
    page.close()


def test_adjustment_functions(viewer):
    # causalweb_adjustment.js is not on the page, so the test loads it.
    page = viewer.open()
    page.add_script_tag(path=str(STATIC_DIR / "causalweb_adjustment.js"))
    result = page.evaluate("""(() => {
      var Q = window.CausalGraphQuery, A = window.CausalGraphAdjustment;
      function model(nodes, edges, det) {
        return Q.build({
          nodes: nodes.map(id => ({id: id, label: id,
                                   deterministic: (det || []).includes(id)})),
          edges: edges.map(e => ({source: e[0], target: e[1]})),
        });
      }
      var chain = model(["a", "b", "c"], [["a", "b"], ["b", "c"]]);
      var collider = model(["a", "b", "c"], [["a", "c"], ["b", "c"]]);
      var fork = ["q", "p", "x", "y"], forkEdges = [["q", "p"], ["p", "x"], ["p", "y"]];
      var backdoor = model(["z", "x", "y"], [["z", "x"], ["x", "y"], ["z", "y"]]);

      // analyze() tests for a common cause without conditioning. It must
      // agree with the back-door test given the empty set.
      var data = JSON.parse(
        document.querySelector("script.causal-graph-data").textContent);
      var ids = data.nodes.map(n => n.id), mismatches = [], confounded = 0;
      ids.forEach(a => ids.forEach(b => {
        if (a === b) return;
        var ans = Q.analyze(data, a, b);
        if (ans.confounded) confounded += 1;
        if (ans.confounded !== A.confounded(ans.model, ans.from, ans.to, []))
          mismatches.push([a, b]);
      }));
      return {
        chain: A.dSeparated(chain, ["a"], ["c"], []),
        chainGivenMiddle: A.dSeparated(chain, ["a"], ["c"], ["b"]),
        collider: A.dSeparated(collider, ["a"], ["b"], []),
        colliderGivenChild: A.dSeparated(collider, ["a"], ["b"], ["c"]),
        randomFork: A.dSeparated(model(fork, forkEdges), ["x"], ["y"], ["q"]),
        deterministicFork: A.dSeparated(model(fork, forkEdges, ["p"]),
                                        ["x"], ["y"], ["q"]),
        backdoor: A.confounded(backdoor, "x", "y", []),
        backdoorGivenZ: A.confounded(backdoor, "x", "y", ["z"]),
        pairs: ids.length * (ids.length - 1),
        confounded: confounded,
        mismatches: mismatches,
      };
    })()""")
    pairs, confounded = result.pop("pairs"), result.pop("confounded")
    assert result == {
        "chain": False, "chainGivenMiddle": True,
        "collider": True, "colliderGivenChild": False,
        # fixing q fixes p only when p is an exact function of q
        "randomFork": False, "deterministicFork": True,
        "backdoor": True, "backdoorGivenZ": False,
        "mismatches": [],
    }
    assert 0 < confounded < pairs
    assert viewer.errors == []
    page.close()
