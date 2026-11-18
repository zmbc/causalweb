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

# Collapsed, g has two edges into h, which the matrix shows as one cell.
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

# Collapsed, h and k share the cause g. a and b share u, but inside g.
FORK = """
groups:
  - name: g
    contains: [u, a]
  - name: h
    contains: [b]
  - name: k
    contains: [c]
nodes:
  - name: u
  - name: a
    caused_by: [u]
  - name: b
    caused_by: [u]
  - name: c
    caused_by: [u]
"""

# a causes d through b and through c, two legs whose routes share no variable.
ROUTES = """
nodes:
  - name: a
  - name: b
    caused_by: [a]
  - name: c
    caused_by: [a]
  - name: d
    caused_by: [b, c]
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
    # a cell between groups says what it marks
    assert mx_tip(page, "g:early", "g:late") == (
        "Early to Late\nDirect causal effect\nIndirect correlation")

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


def test_reset_view_shows_after_a_zoom(viewer):
    page = viewer.open()
    fit = ".causal-graph .cg-fit"
    assert not page.is_visible(fit)
    box = page.query_selector(".cg-canvases").bounding_box()
    page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
    page.mouse.wheel(0, -300)
    time.sleep(0.3)
    assert page.is_visible(fit)
    page.click(fit)
    time.sleep(0.2)
    assert not page.is_visible(fit)
    assert viewer.errors == []
    page.close()


def test_group_boxes_can_be_left_out(viewer):
    page = viewer.open()
    assert state(page)["boxes"] == 3
    page.get_by_label("Group boxes").uncheck()
    ready(page)
    st = state(page)
    assert st["boxes"] == 0
    assert st["nodes"] == ["a", "b", "c", "d", "e", "x"]
    assert "boxes=0" in st["hash"]
    page.reload()
    ready(page)
    assert state(page)["boxes"] == 0
    assert not page.get_by_label("Group boxes").is_checked()
    assert viewer.errors == []
    page.close()


CELLS = """(() => {
  var td = document.querySelector('td.cg-mx-cell'), sc = document.querySelector('.cg-matrix-scroll');
  return {w: td.getBoundingClientRect().width, h: td.getBoundingClientRect().height,
          fits: sc.scrollWidth <= sc.clientWidth && sc.scrollHeight <= sc.clientHeight};
})()"""


def test_matrix_cells_fit_the_pane(viewer):
    page = viewer.open()
    # with room to spare, the cells are at their largest, 32 pixels and a
    # grid line
    cells = page.evaluate(CELLS)
    assert cells["w"] == cells["h"] == 33
    assert cells["fits"]
    # in a narrow window they shrink so the table still fits, and stay square
    page.set_viewport_size({"width": 560, "height": 800})
    time.sleep(0.5)
    cells = page.evaluate(CELLS)
    assert 12 <= cells["w"] < 33
    assert cells["w"] == cells["h"]
    assert cells["fits"]
    assert viewer.errors == []
    page.close()


def test_tooltips_match_across_panes(viewer):
    page = viewer.open()
    filter_to(page, ["a", "d"])
    style = ("(() => { var s = getComputedStyle(document.querySelector('%s'));"
             " return [s.fontSize, s.lineHeight, s.textAlign, s.whiteSpace]; })()")
    page.hover('td[data-s="a"][data-t="d"]')
    time.sleep(0.2)
    in_matrix = page.evaluate(style % ".causal-graph .cg-tip")
    page.click('td[data-s="a"][data-t="d"]')
    menu_in_matrix = page.evaluate(style % ".causal-graph .cg-choose")
    page.keyboard.press("Escape")
    page.mouse.move(0, 0)
    assert_routed(page)
    at = page.evaluate("""(() => {
      var c = document.querySelector('.causal-graph'), e = c._cyForTest.getElementById('la>d');
      var p = e.renderedMidpoint(), r = c.querySelector('.cg-canvases').getBoundingClientRect();
      return {x: r.left + p.x, y: r.top + p.y}; })()""")
    page.mouse.move(at["x"], at["y"])
    time.sleep(0.2)
    assert page.evaluate("!document.querySelector('.causal-graph .cg-tip').hidden")
    assert page.evaluate(style % ".causal-graph .cg-tip") == in_matrix
    page.mouse.click(at["x"], at["y"])
    assert page.evaluate(style % ".causal-graph .cg-choose") == menu_in_matrix
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


def mx_tip(page, s, t):
    """The tooltip of a matrix cell."""
    page.hover('td[data-s="%s"][data-t="%s"]' % (s, t))
    time.sleep(0.2)
    return page.evaluate("document.querySelector('.causal-graph .cg-tip').textContent")


def filter_to(page, ids):
    """Turn the filter on, if it is off, and show only `ids`."""
    if page.evaluate("document.querySelector('.causal-graph-panel').hidden"):
        click(page, "Filter")
    click(page, "Reset")
    for id in ids:
        page.click('.cg-filter-list input[data-id="%s"]' % id)
        ready(page)


MENU = ".causal-graph .cg-choose:not([hidden]) button"


def test_matrix_hover_and_click(viewer):
    page = viewer.open()
    page.hover('td[data-s="a"][data-t="b"]')
    time.sleep(0.2)
    # the cause's row header and the effect's column header light up
    lit = page.evaluate("Array.from(document.querySelectorAll('th.cg-mx-hl'))"
                        ".map(th => th.className.split(' ')[0] + ':' + th.getAttribute('data-b'))")
    assert sorted(lit) == ["cg-mx-col:b", "cg-mx-row:a"]
    assert page.evaluate("document.querySelectorAll('td.cg-mx-hl').length") == 1
    # the tooltip names the pair, row first, then says what the cell marks
    assert mx_tip(page, "a", "b") == "A to B\nDirect causal effect\nNo correlation"
    # below the diagonal, the row causes nothing in the column
    assert mx_tip(page, "b", "a") == "B to A\nNo causal effect\nNo correlation"
    # there a <-> or a back-door path is what the cell marks
    assert mx_tip(page, "d", "x") == (
        "Shared name (Late) to X\nNo causal effect\nIndirect correlation")
    # a reaches e through the variables shown, and is correlated with it
    # through x, which it is declared correlated with, and which causes d
    assert mx_tip(page, "a", "e") == (
        "A to Shared name (Late)\nIndirect causal effect\nIndirect correlation")
    # x causes d, and a back-door path joins them: x <-> a -> b -> c -> d
    assert mx_tip(page, "x", "d") == (
        "X to Shared name (Late)\nDirect causal effect\nIndirect correlation")
    page.hover('td[data-s="a"][data-t="b"]')
    time.sleep(0.2)
    hovered = page.evaluate(
        "document.querySelector('.causal-graph')._cyForTest.elements('.hovered').map(e => e.id()).sort()")
    assert hovered == ["a", "b", "ea>b"]

    page.click('th.cg-mx-row[data-b="b"]')
    time.sleep(0.2)
    assert page.evaluate("!!document.querySelector('table.cg-mx.cg-mx-focus')")
    picked = page.evaluate(
        "document.querySelector('.causal-graph')._cyForTest.nodes('.picked').map(n => n.id())")
    assert picked == ["b"]
    page.click('th.cg-mx-row[data-b="b"]')

    # with only a and d shown: a leg a -> d through b and c, and a <->
    # because a is declared correlated with x, which causes d
    filter_to(page, ["a", "d"])
    st = state(page)
    assert st["order"] == ["a", "d"]
    assert st["direct"] == []
    assert st["corr"] == 2
    assert "show=a,d" in st["hash"]
    page.hover('td[data-s="a"][data-t="d"]')
    time.sleep(0.2)
    tip = page.evaluate("document.querySelector('.causal-graph .cg-tip').textContent")
    # what the leg and the <-> stand for is left to the diagram's tooltip
    assert tip == "A to Shared name (Late)\nDirect causal effect\nDirect correlation"

    # the leg is a chain of two, so a click asks which to reveal
    page.click('td[data-s="a"][data-t="d"]')
    assert page.eval_on_selector_all(MENU, "bs => bs.map(b => b.textContent)") == ["B", "C"]
    # the menu says it all, so no tooltip covers it
    page.hover('td[data-s="a"][data-t="d"]')
    time.sleep(0.2)
    assert page.evaluate("document.querySelector('.causal-graph .cg-tip').hidden")
    # Escape closes the menu, and reveals nothing
    page.keyboard.press("Escape")
    assert not page.query_selector(MENU)
    page.click('td[data-s="a"][data-t="d"]')
    page.click(MENU + '[data-id="b"]')
    ready(page)
    assert sorted(state(page)["order"]) == ["a", "b", "d"]
    assert not page.query_selector(MENU)
    # what is left of the chain is one variable, which a click reveals
    page.click('td[data-s="b"][data-t="d"]')
    ready(page)
    st = state(page)
    assert sorted(st["order"]) == ["a", "b", "c", "d"]
    assert sorted(st["direct"]) == [["a", "b"], ["b", "c"], ["c", "d"]]
    assert_routed(page)       # the morph carried the routes over
    # revealed variables are checked in the filter
    checked = page.eval_on_selector_all(
        ".cg-filter-list input:checked", "bs => bs.map(b => b.getAttribute('data-id')).sort()")
    assert checked == ["a", "b", "c", "d"]
    contracted = page.evaluate(
        "document.querySelector('.causal-graph')._cyForTest.edges('[contracted = 1]')"
        ".map(e => e.id()).sort()")
    assert contracted == []          # nothing hidden is left on the chain
    # the view is in the fragment and survives a reload
    assert "show=a,b,c,d" in st["hash"]
    page.reload()
    ready(page)
    assert sorted(state(page)["order"]) == ["a", "b", "c", "d"]

    # Undo takes back one change at a time
    page.reload()
    ready(page)
    filter_to(page, ["a", "d"])
    page.click('td[data-s="a"][data-t="d"]')
    page.click(MENU + '[data-id="c"]')
    ready(page)
    assert sorted(state(page)["order"]) == ["a", "c", "d"]
    click(page, "Undo")
    assert_routed(page)
    assert sorted(state(page)["order"]) == ["a", "d"]
    click(page, "Undo")
    assert sorted(state(page)["order"]) == ["a"]

    # the filter belongs to the "Every variable" level; at others, every
    # variable is shown, and the filter comes back with the level
    click(page, "By phase")
    st = state(page)
    assert st["nodes"] == ["g:early", "g:late", "x"]
    assert st["panelHidden"]
    assert not page.get_by_role("button", name="Filter", exact=True).is_visible()
    assert not page.get_by_role("button", name="Undo", exact=True).is_visible()
    click(page, "Every variable")
    assert state(page)["nodes"] == ["a"]
    assert viewer.errors == []
    page.close()


def test_filter_shortcuts(viewer):
    page = viewer.open()
    # the filter starts with nothing checked, and says so
    click(page, "Filter")
    assert state(page)["nodes"] == []
    assert page.evaluate("!document.querySelector('.cg-empty-note').hidden")
    # unpressed, it shows every variable again
    click(page, "Filter")
    st = state(page)
    assert st["nodes"] == ["a", "b", "c", "d", "e", "x"]
    assert st["panelHidden"]
    assert "show=" not in st["hash"]

    # a cell of the matrix filters to its pair
    page.click('td[data-s="a"][data-t="b"]')
    ready(page)
    st = state(page)
    assert st["nodes"] == ["a", "b"]
    assert "show=a,b" in st["hash"]
    assert not st["panelHidden"]

    # a variable on the diagram filters to it alone
    click(page, "Filter")
    assert_routed(page)
    click_node(page, "b")
    assert state(page)["nodes"] == ["b"]
    checked = page.eval_on_selector_all(
        ".cg-filter-list input:checked", "bs => bs.map(b => b.getAttribute('data-id'))")
    assert checked == ["b"]
    # Reset unchecks every variable, listed or not, and clears the search
    page.fill(".cg-filter-search", "shared")
    assert page.evaluate("Array.from(document.querySelectorAll('.cg-filter-item'))"
                         ".filter(l => !l.hidden).length") == 2
    click(page, "Reset")
    assert state(page)["nodes"] == []
    assert page.input_value(".cg-filter-search") == ""
    assert page.evaluate("Array.from(document.querySelectorAll('.cg-filter-item'))"
                         ".every(l => !l.hidden)")
    # and Undo takes back one change at a time, the last one turning the
    # filter off, which hides Undo with the rest of the filter
    click(page, "Undo")
    assert state(page)["nodes"] == ["b"]
    click(page, "Undo")
    assert state(page)["nodes"] == ["a", "b", "c", "d", "e", "x"]
    assert not page.get_by_role("button", name="Undo", exact=True).is_visible()
    assert viewer.errors == []
    page.close()


def click_node(page, node_id):
    at = page.evaluate("""(id => {
      var c = document.querySelector('.causal-graph'), n = c._cyForTest.getElementById(id);
      var p = n.renderedPosition(), r = c.querySelector('.cg-canvases').getBoundingClientRect();
      return {x: r.left + p.x, y: r.top + p.y}; })""", node_id)
    page.mouse.click(at["x"], at["y"])
    ready(page)


def test_each_leg_is_an_arrow_of_its_own(viewer, tmp_path):
    path = tmp_path / "routes.yaml"
    path.write_text(ROUTES, encoding="utf-8")
    page = viewer.open_graph(path)
    filter_to(page, ["a", "d"])
    assert_routed(page)
    tips = page.evaluate("""(() => {
      var c = document.querySelector('.causal-graph');
      return c._cyForTest.edges('[contracted = 1]').map(e => c._edgesForTest.tip(e.id())).sort();
    })()""")
    assert tips == ["via B", "via C"]
    # hovering the cell lights both
    page.hover('td[data-s="a"][data-t="d"]')
    time.sleep(0.2)
    hovered = page.evaluate(
        "document.querySelector('.causal-graph')._cyForTest.edges('.hovered').length")
    assert hovered == 2
    assert viewer.errors == []
    page.close()


def test_indirect_correlation_follows_the_level(viewer, tmp_path):
    path = tmp_path / "fork.yaml"
    path.write_text(FORK, encoding="utf-8")
    page = viewer.open_graph(path)
    far = ("(() => { var mx = document.querySelector('.causal-graph')._matrixForTest;"
           " return Object.keys(mx.far).map(k => k.split('\\0'))"
           ".filter(p => p[0] < p[1]).map(p => p.join('|')).sort(); })()")
    assert page.evaluate(far) == ["a|b", "a|c", "b|c"]
    # collapsed, the diagram shows g causing h and k, and nothing for u
    # causing a and b inside and outside g
    click(page, "Level 1")
    assert page.evaluate(far) == ["g:h|g:k"]
    assert viewer.errors == []
    page.close()


def test_filter_list_order(viewer):
    page = viewer.open()
    click(page, "Filter")
    ids = ("Array.from(document.querySelectorAll('.cg-filter-list input'))"
           ".map(b => b.getAttribute('data-id'))")
    # causal order, as in the matrix with every variable shown
    assert page.evaluate(ids) == ["a", "b", "c", "x", "d", "e"]
    # the checked variables come first, and a box keeps the focus it had
    page.click('.cg-filter-list input[data-id="d"]')
    ready(page)
    page.click('.cg-filter-list input[data-id="b"]')
    ready(page)
    assert page.evaluate(ids) == ["b", "d", "a", "c", "x", "e"]
    assert page.evaluate("document.activeElement.getAttribute('data-id')") == "b"
    page.click('.cg-filter-list input[data-id="b"]')
    ready(page)
    assert page.evaluate(ids) == ["d", "a", "b", "c", "x", "e"]
    assert viewer.errors == []
    page.close()


def test_duplicate_labels_are_told_apart(viewer):
    page = viewer.open()
    page.get_by_role("button", name="Filter", exact=True).click()
    labels = page.eval_on_selector_all(".cg-filter-item", "ls => ls.map(l => l.textContent)")
    assert labels.count("Shared name (Late)") == 2
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
        "matrix": ["direct edge", "causal path through the variables shown", "correlated",
                   "correlated through the variables shown", note],
    }
    # the deterministic variable and the outcome are inside closed groups
    click(page, "By phase")
    assert page.evaluate(LEGENDS) == {
        "graph": ["causes", "correlated"],
        "matrix": ["direct edge", "correlated", "correlated through the variables shown", note],
    }
    # a and d alone: a leg through b and c, and a <-> for the declared
    # correlation of a with x, which causes d
    click(page, "Every variable")
    filter_to(page, ["a", "d"])
    assert page.evaluate(LEGENDS) == {
        "graph": ["outcome", "causes through hidden variables", "correlated"],
        "matrix": ["path through hidden variables", "correlated", note],
    }
    page.close()

    path = tmp_path / "double.yaml"
    path.write_text(DOUBLE, encoding="utf-8")
    page = viewer.open_graph(path)
    assert page.evaluate(LEGENDS)["matrix"] == ["direct edge", note]
    # a and b share no cause, and neither causes the other
    assert mx_tip(page, "a", "b") == "A to B\nNo causal effect\nNo correlation"
    click(page, "Level 1")
    assert page.evaluate(LEGENDS)["matrix"] == ["direct edge", note]
    assert page.evaluate("document.querySelector('td.cg-mx-direct').textContent") == ""
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
      };
    })()""")
    assert result == {
        "chain": False, "chainGivenMiddle": True,
        "collider": True, "colliderGivenChild": False,
        # fixing q fixes p only when p is an exact function of q
        "randomFork": False, "deterministicFork": True,
        "backdoor": True, "backdoorGivenZ": False,
    }
    assert viewer.errors == []
    page.close()


def test_summary_keeps_d_separation(viewer):
    # On random graphs with declared correlations: the solid arrows are the
    # graph's edges among the visible variables, and the summary, read as a
    # graph with a hidden parent for each <->, has the same d-separations
    # among them as the graph, given nothing or any one of them.
    page = viewer.open()
    page.add_script_tag(path=str(STATIC_DIR / "causalweb_adjustment.js"))
    result = page.evaluate("""(() => {
      var Q = window.CausalGraphQuery, A = window.CausalGraphAdjustment;
      var seed = 11, failures = [], tests = 0;
      function rnd() { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }
      for (var g = 0; g < 200; g++) {
        var n = 3 + Math.floor(rnd() * 6), ids = [], edges = [], corr = [];
        for (var i = 0; i < n; i++) ids.push("v" + i);
        var p = 0.2 + rnd() * 0.4;
        for (var i = 0; i < n; i++) for (var j = i + 1; j < n; j++) {
          if (rnd() < p) edges.push({source: ids[i], target: ids[j]});
        }
        for (var c = Math.floor(rnd() * 3); c > 0; c--) {
          var x = Math.floor(rnd() * n), y = Math.floor(rnd() * n);
          if (x !== y) corr.push([ids[x], ids[y]]);
        }
        var m = Q.build({nodes: ids.map(id => ({id: id, label: id})), edges: edges, correlated: corr});
        var vis = ids.filter(() => rnd() < 0.5);
        if (vis.length < 2) continue;
        var s = Q.summarize(m, vis), V = new Set(vis);
        var full = edges.filter(e => V.has(e.source) && V.has(e.target))
          .map(e => e.source + ">" + e.target).sort();
        var solid = s.solid.map(e => e.source + ">" + e.target).sort();
        if (full.join() !== solid.join()) failures.push(["edges", g]);
        var nodes = vis.map(id => ({id: id, label: id})), sEdges = [], seen = {};
        s.solid.concat(s.legs).forEach(e => {
          var k = e.source + ">" + e.target;
          if (!seen[k]) { seen[k] = true; sEdges.push({source: e.source, target: e.target}); }
        });
        s.bidirected.forEach((e, i) => {
          nodes.push({id: "~" + i, label: "~" + i});
          sEdges.push({source: "~" + i, target: e.source}, {source: "~" + i, target: e.target});
        });
        var sm = Q.build({nodes: nodes, edges: sEdges});
        vis.forEach((a, i) => vis.slice(i + 1).forEach(b => {
          [[]].concat(vis.filter(z => z !== a && z !== b).map(z => [z])).forEach(Z => {
            tests += 1;
            if (A.dSeparated(m, [a], [b], Z) !== A.dSeparated(sm, [a], [b], Z)) {
              failures.push([g, a, b, Z]);
            }
          });
        }));
      }
      return {tests: tests, failures: failures.slice(0, 5)};
    })()""")
    assert result["failures"] == []
    assert result["tests"] > 500
    assert viewer.errors == []
    page.close()


def test_routes_and_common_causes(viewer):
    # The query module, on small graphs given inline.
    page = viewer.open()
    result = page.evaluate("""(() => {
      var Q = window.CausalGraphQuery;
      function model(nodes, edges, correlated) {
        return Q.build({
          nodes: nodes.map(id => ({id: id, label: id})),
          edges: edges.map(e => ({source: e[0], target: e[1]})),
          correlated: correlated || [],
        });
      }
      function leg(m, visible, a, b) {
        return Q.summarize(m, visible).legs.filter(l => l.source === a && l.target === b)[0];
      }
      // every route from a to d passes p; from p, s is skipped by p -> d
      var m1 = model(["a", "p", "s", "d"], [["a", "p"], ["p", "s"], ["p", "d"], ["s", "d"]]);
      // every route from a to d passes p or q; c comes before them, f after
      var m2 = model(["a", "c", "p", "q", "f", "d"],
        [["a", "p"], ["a", "q"], ["a", "c"], ["c", "p"], ["c", "q"],
         ["p", "f"], ["f", "d"], ["p", "d"], ["q", "d"]]);
      // x and y are caused by g and h; g and h are caused by z; the smallest
      // set of common causes is {g, h}, not the parents of x
      var m3 = model(["z", "g", "h", "px", "qx", "x", "y"],
        [["z", "g"], ["z", "h"], ["g", "px"], ["h", "qx"], ["px", "x"], ["qx", "x"],
         ["g", "y"], ["h", "y"]]);
      // the tooltip's steps: p, then a stretch a direct edge skips; and a
      // set of p and q, with hidden variables before and after it
      function steps(st) { return st.map(x => x.gap ? "..." : x.names.join(",")); }
      return {
        steps1: steps(Q.routeSteps(m1, leg(m1, ["a", "d"], "a", "d"))),
        steps2: steps(Q.routeSteps(m2, leg(m2, ["a", "d"], "a", "d"))),
        causes: Q.causeCut(m3, ["x", "y"], "x", "y"),
      };
    })()""")
    assert result["steps1"] == ["p", "..."]
    assert result["steps2"] == ["...", "p,q", "..."]
    assert result["causes"] == ["g", "h"]
    assert viewer.errors == []
    page.close()
