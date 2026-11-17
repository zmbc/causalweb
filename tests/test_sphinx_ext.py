"""Tests for the Sphinx extension.

Skipped when Sphinx is not installed.
"""
import io
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _path  # noqa: E402,F401

from causalweb.model import CausalGraph  # noqa: E402

try:
    from sphinx.application import Sphinx
    from causalweb import sphinx_ext
except ImportError:
    sphinx_ext = None

NESTED = Path(__file__).resolve().parent / "nested.yaml"

INDEX = """\
Graph
=====

.. causal-graph:: graph.yaml
   :collapse: 1

.. causal-graph-table:: early
   :file: graph.yaml

.. causal-graph-table:: late
   :file: graph.yaml
   :group-header: Part
   :inputs-header: Reads
   :outputs-header: Writes
   :documentation-header: Nested subcomponents
"""


def graph(data):
    return CausalGraph(data, Path("test.yaml"))


@unittest.skipIf(sphinx_ext is None, "Sphinx is not installed")
class DataKeyTests(unittest.TestCase):
    def test_categories(self):
        g = graph({"nodes": [
            {"name": "a", "data": {"categories": ["mild", "severe"]}},
            {"name": "b"},
            {"name": "c", "data": {"categories": "mild"}},
            {"name": "d", "data": {"categories": ["mild", 2]}},
        ]})
        self.assertEqual(sphinx_ext.categories_of(g.nodes["a"]), ["mild", "severe"])
        self.assertEqual(sphinx_ext.categories_of(g.nodes["b"]), [])
        self.assertEqual(sphinx_ext.categories_of(g.nodes["c"]), [])
        self.assertEqual(g.problems, [])
        problems = sphinx_ext.data_problems(g)
        self.assertEqual(len(problems), 2)
        self.assertIn("'c' has categories 'mild', which is not a list of strings",
                      problems)

    def test_documentation_ref(self):
        g = graph({"groups": [{"name": "g", "data": {"documentation_ref": {"text": "x"}}}],
                   "nodes": [{"name": "a", "data": {"documentation_ref": ["r1", 5]}}]})
        problems = sphinx_ext.data_problems(g)
        self.assertIn("'g' has a documentation_ref mapping with no 'ref' key", problems)
        self.assertIn("'a' has a malformed documentation_ref: 5", problems)


@unittest.skipIf(sphinx_ext is None, "Sphinx is not installed")
class BuildTests(unittest.TestCase):
    def test_build(self):
        with tempfile.TemporaryDirectory() as tmp:
            src, out = Path(tmp) / "src", Path(tmp) / "out"
            src.mkdir()
            (src / "conf.py").write_text('extensions = ["causalweb.sphinx_ext"]\n')
            # e1b is an output of early_one and an input of e_mid
            yaml = NESTED.read_text(encoding="utf-8").replace(
                "  - name: e1b\n    caused_by: [e1a]\n",
                "  - name: e1b\n    caused_by: [e1a]\n    data:\n      categories: [low, high]\n")
            self.assertIn("categories", yaml)
            (src / "graph.yaml").write_text(yaml, encoding="utf-8")
            (src / "index.rst").write_text(INDEX)
            warnings = io.StringIO()
            app = Sphinx(str(src), str(src), str(out), str(Path(tmp) / "doctrees"),
                         "html", status=None, warning=warnings, freshenv=True)
            app.build()
            self.assertEqual(warnings.getvalue(), "")
            html = (out / "index.html").read_text(encoding="utf-8")
            self.assertTrue((out / "_static" / "graph.html").is_file())
            self.assertTrue((out / "_static" / "causalweb.js").is_file())
        # the viewer shows its "New tab" button only with this attribute
        self.assertIn('data-standalone="graph.html?v=', html)

        tables = html.split('<table class="causal-graph-table')[1:]
        self.assertEqual(len(tables), 2)
        # defaults: the level label of the subgroups, then the fixed names
        for header in ("Step", "Inputs", "Outputs", "Documentation"):
            self.assertIn(f"<p>{header}</p>", tables[0])
        for header in ("Part", "Reads", "Writes", "Nested subcomponents"):
            self.assertIn(f"<p>{header}</p>", tables[1])
        self.assertNotIn("<p>Documentation</p>", tables[1])
        # categories follow the label among the outputs, and not the inputs
        self.assertEqual(tables[0].count("(low | high)"), 1)


if __name__ == "__main__":
    unittest.main()
