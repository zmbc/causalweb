"""Drive the viewer in headless Chromium.

Skipped when Playwright or a launchable browser is missing. On a machine with
no system fonts or Chromium libraries, point the browser at them first, for
example::

    LD_LIBRARY_PATH=/path/to/libs FONTCONFIG_FILE=/path/to/fonts.conf \\
        python -m unittest tests.test_ui

The environment is passed through to the browser process as is.
"""

import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _path  # noqa: E402,F401

from causalweb.server import GraphServer  # noqa: E402

try:
    from playwright.sync_api import sync_playwright
except ImportError:  # pragma: no cover
    sync_playwright = None

# The MNCNH graph lives in the vivarium_research repository. The tests that
# use it look for a checkout beside this one, or at $CAUSALWEB_MNCNH.
MNCNH = Path(os.environ.get(
    "CAUSALWEB_MNCNH",
    Path(__file__).resolve().parents[2] / "vivarium_research/docs/source/models"
    "/concept_models/vivarium_mncnh_portfolio/causal_graph.yaml"))

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

READY = ("(() => { var c = document.querySelector('.causal-graph');"
         " return !!(c && c._cyForTest); })()")


def browser_available():
    if sync_playwright is None:
        return False
    try:
        with sync_playwright() as p:
            b = p.chromium.launch(env=dict(os.environ), args=["--no-sandbox"])
            b.close()
        return True
    except Exception:
        return False


@unittest.skipUnless(browser_available(), "no headless browser available")
class ViewerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.file = Path(cls.tmp.name) / "small.yaml"
        cls.file.write_text(SMALL, encoding="utf-8")
        cls.server = GraphServer(cls.file, port=0, quiet=True)
        cls.server.start()
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch(env=dict(os.environ), args=["--no-sandbox"])

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()
        cls.server.stop()
        cls.tmp.cleanup()

    def open(self, url=None):
        page = self.browser.new_page(viewport={"width": 1400, "height": 800})
        self.errors = []
        page.on("pageerror", lambda e: self.errors.append(str(e)))
        page.goto(url or self.server.url)
        self.ready(page)
        return page

    def ready(self, page):
        page.wait_for_function(READY, timeout=60000)
        time.sleep(0.3)

    def click(self, page, name):
        page.get_by_role("button", name=name, exact=True).click()
        self.ready(page)

    def state(self, page):
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

    def test_presets_and_matrix(self):
        page = self.open()
        st = self.state(page)
        self.assertEqual(st["nodes"], ["a", "b", "c", "d", "e", "x"])
        self.assertEqual(st["boxes"], 3)
        self.assertFalse(st["matrix"])

        self.click(page, "By phase")
        st = self.state(page)
        self.assertEqual(st["nodes"], ["g:early", "g:late", "x"])
        self.assertEqual(st["hash"], "#open=")

        self.click(page, "Matrix")
        st = self.state(page)
        self.assertTrue(st["matrix"])
        # x causes d, which is in `late`, so x sits between the two groups
        self.assertEqual(st["order"], ["g:early", "x", "g:late"])
        self.assertEqual(sorted(st["direct"]), [["g:early", "g:late"], ["x", "g:late"]])
        self.assertEqual(st["corr"], 2)
        self.assertIn("mx=1", st["hash"])

        self.click(page, "Every variable")
        st = self.state(page)
        pos = {b: i for i, b in enumerate(st["order"])}
        for s, t in st["direct"]:
            self.assertLess(pos[s], pos[t])
        self.assertEqual(len(st["direct"]), 5)
        self.assertGreater(st["reach"], 0)
        self.assertRouted(page)
        self.assertEqual(self.errors, [])
        page.close()

    def assertRouted(self, page):
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
        self.assertTrue(styles)
        for curve, distances in styles:
            self.assertIn(curve, ("segments", "round-segments", "straight"))
            self.assertEqual(distances, "endpoints")

    def test_state_survives_reload(self):
        page = self.open()
        self.click(page, "Matrix")
        self.click(page, "By phase")
        before = self.state(page)
        page.reload()
        self.ready(page)
        after = self.state(page)
        self.assertEqual(after["nodes"], before["nodes"])
        self.assertTrue(after["matrix"])
        self.assertEqual(after["hash"], before["hash"])
        page.close()

    def test_matrix_hover_and_click(self):
        page = self.open()
        self.click(page, "Matrix")
        page.hover('td[data-s="a"][data-t="b"]')
        time.sleep(0.2)
        # both buckets' row and column headers light up
        self.assertEqual(page.evaluate("document.querySelectorAll('th.cg-mx-hl').length"), 4)
        self.assertEqual(page.evaluate("document.querySelectorAll('td.cg-mx-hl').length"), 1)
        tip = page.evaluate("document.querySelector('.cg-matrix .cg-tip').textContent")
        self.assertIn("A → B", tip)
        hovered = page.evaluate(
            "document.querySelector('.causal-graph')._cyForTest.elements('.hovered').map(e => e.id()).sort()")
        self.assertEqual(hovered, ["a", "b", "ea>b"])

        page.click('th.cg-mx-row[data-b="b"]')
        time.sleep(0.2)
        self.assertTrue(page.evaluate("!!document.querySelector('table.cg-mx.cg-mx-focus')"))
        picked = page.evaluate(
            "document.querySelector('.causal-graph')._cyForTest.nodes('.picked').map(n => n.id())")
        self.assertEqual(picked, ["b"])

        # a cell between two variables asks the query about them
        page.click('td[data-s="a"][data-t="d"]')
        self.ready(page)
        st = self.state(page)
        self.assertFalse(st["panelHidden"])
        self.assertIn("q=a,d", st["hash"])
        text = page.evaluate("document.querySelector('.causal-graph-panel').textContent")
        self.assertIn("A causes Shared name (Late)", text)

        # the matrix stays up, now of the projection. a and x are correlated
        # and x causes d, so x is kept: legs a -> d and x -> d, and a <-> x.
        self.assertTrue(st["matrix"])
        self.assertEqual(st["order"], ["a", "x", "d"])
        self.assertEqual(sorted(st["direct"]), [["a", "d"], ["x", "d"]])
        self.assertEqual(st["corr"], 2)
        # clicking the a -> d leg opens it at its waist, b
        page.click('td[data-s="a"][data-t="d"]')
        self.ready(page)
        st = self.state(page)
        self.assertEqual(sorted(st["order"]), ["a", "b", "d", "x"])
        self.assertEqual(sorted(st["direct"]), [["a", "b"], ["b", "d"], ["x", "d"]])
        self.assertRouted(page)       # the morph carried the routes over
        # headers say only what they are; the colour carries the role
        page.hover('th.cg-mx-row[data-b="b"]')
        time.sleep(0.2)
        tip = page.evaluate("document.querySelector('.cg-matrix .cg-tip').textContent")
        self.assertEqual(tip, "B")
        contracted = page.evaluate(
            "document.querySelector('.causal-graph')._cyForTest.edges('[contracted = 1]')"
            ".map(e => e.id()).sort()")
        self.assertEqual(contracted, ["pb>d"])
        roles = page.evaluate(
            "(() => { var cy = document.querySelector('.causal-graph')._cyForTest;"
            " var r = {}; cy.nodes().forEach(n => r[n.id()] = n.data('role')); return r; })()")
        self.assertEqual(roles, {"a": "query", "d": "query", "b": "via", "x": "via"})
        # the opened leg is in the fragment and survives a reload
        self.assertIn("x=b", st["hash"])
        page.reload()
        self.ready(page)
        st = self.state(page)
        self.assertEqual(sorted(st["order"]), ["a", "b", "d", "x"])
        # and can be folded back, then opened once more, each a morph that
        # eases edges from values the previous ease left behind
        self.click(page, "Collapse again")
        self.assertRouted(page)
        self.assertEqual(sorted(self.state(page)["order"]), ["a", "d", "x"])
        page.click('td[data-s="a"][data-t="d"]')
        self.ready(page)
        self.assertRouted(page)
        self.assertEqual(sorted(self.state(page)["order"]), ["a", "b", "d", "x"])
        self.assertEqual(self.errors, [])
        page.close()

    def test_duplicate_labels_are_told_apart(self):
        page = self.open()
        self.click(page, "Query")
        options = page.evaluate(
            "Array.from(document.querySelector('.causal-graph-panel select').options).map(o => o.text)")
        self.assertIn("Shared name (Late)", options)
        self.assertEqual(options.count("Shared name (Late)"), 2)
        page.close()

    def test_live_reload(self):
        page = self.open()
        count = ("(() => { var c = document.querySelector('.causal-graph');"
                 " return c && c._cyForTest &&"
                 " c._cyForTest.edges('[kind = \"correlated\"]').length === %d; })()")
        try:
            self.file.write_text(SMALL + "  - [b, x]\n", encoding="utf-8")
            page.wait_for_function(count % 2, timeout=60000)
        finally:
            # the other tests share this file, so it goes back whatever happened
            self.file.write_text(SMALL, encoding="utf-8")
        page.wait_for_function(count % 1, timeout=60000)
        page.close()

    @unittest.skipUnless(MNCNH.is_file(), "MNCNH graph not present")
    def test_mncnh_matrix_is_upper_triangular_at_every_level(self):
        server = GraphServer(MNCNH, port=0, quiet=True)
        server.start()
        try:
            page = self.open(server.url)
            self.click(page, "Matrix")
            for preset in ("By component", "By module", "Every variable"):
                self.click(page, preset)
                st = self.state(page)
                pos = {b: i for i, b in enumerate(st["order"])}
                for s, t in st["direct"]:
                    self.assertLess(pos[s], pos[t], (preset, s, t))
            self.assertEqual(len(st["direct"]), 208)
            self.assertEqual(self.errors, [])
            page.close()
        finally:
            server.stop()


if __name__ == "__main__":
    unittest.main()
