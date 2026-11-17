"""Tests for the Sphinx extension's own keys in ``data``.

Skipped when Sphinx is not installed.
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _path  # noqa: E402,F401

from causalweb.model import CausalGraph  # noqa: E402

try:
    from causalweb import sphinx_ext
except ImportError:
    sphinx_ext = None


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


if __name__ == "__main__":
    unittest.main()
