import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _path  # noqa: E402,F401

from causalweb.model import CausalGraph, GraphError, load_graph  # noqa: E402


def graph(data):
    return CausalGraph(data, Path("test.yaml"))


SMALL = {
    "level_labels": ["phase"],
    "groups": [
        {"name": "early", "contains": ["b", "a", "inner"]},
        {"name": "late", "contains": ["d"]},
        {"name": "inner", "contains": ["c"]},
    ],
    "nodes": [
        {"name": "a"},
        {"name": "b", "caused_by": ["a"]},
        {"name": "c", "caused_by": ["b"], "deterministic": True},
        {"name": "d", "caused_by": ["c", "x"], "kind": "outcome"},
        {"name": "x"},
    ],
    "correlated": [["a", "x"]],
}


class ValidationTests(unittest.TestCase):
    def test_small_graph_is_clean(self):
        g = graph(SMALL)
        self.assertEqual(g.problems, [])
        self.assertEqual(g.roots, ["early", "late"])
        self.assertEqual(g.parent_of["inner"], "early")
        self.assertEqual(g.variable_path("c"), ["early", "inner"])
        self.assertEqual(g.variable_path("x"), [])
        self.assertEqual(g.contains["early"], ["b", "a", "g:inner"])

    def test_cycle_reported(self):
        g = graph({"nodes": [{"name": "a", "caused_by": ["b"]},
                             {"name": "b", "caused_by": ["a"]}]})
        self.assertTrue(any("not acyclic" in p for p in g.problems))

    def test_unknown_parent_and_contains(self):
        g = graph({"groups": [{"name": "g", "contains": ["a", "nope"]}],
                   "nodes": [{"name": "a", "caused_by": ["ghost"]}]})
        self.assertTrue(any("unknown parent 'ghost'" in p for p in g.problems))
        self.assertTrue(any("contains unknown 'nope'" in p for p in g.problems))

    def test_duplicates_and_clash(self):
        g = graph({"groups": [{"name": "a"}, {"name": "a"}],
                   "nodes": [{"name": "a"}, {"name": "b"}, {"name": "b"}]})
        self.assertTrue(any("duplicate group names" in p for p in g.problems))
        self.assertTrue(any("duplicate node names" in p for p in g.problems))
        self.assertTrue(any("both a group and a variable" in p for p in g.problems))

    def test_double_containment(self):
        g = graph({"groups": [{"name": "g", "contains": ["a"]},
                              {"name": "h", "contains": ["a"]}],
                   "nodes": [{"name": "a"}]})
        self.assertTrue(any("contained by both" in p for p in g.problems))

    def test_context_and_correlated_checks(self):
        g = graph({"nodes": [{"name": "a"}, {"name": "b", "caused_by": ["a"]}],
                   "correlated": [["a", "zz"], ["a"]],
                   "contexts": [{"name": "s", "fixed": ["q"],
                                 "inactive_edges": [["b", "a"], ["a"]]}]})
        joined = "\n".join(g.problems)
        self.assertIn("unknown variable 'zz'", joined)
        self.assertIn("not a [a, b] pair", joined)
        self.assertIn("fixes unknown variable 'q'", joined)
        self.assertIn("inactive edge 'b' -> 'a', which does not exist", joined)
        self.assertIn("not a [source, target] pair", joined)

    def test_unknown_keys_and_data(self):
        g = graph({"scenarios": [], "groups": [{"name": "g", "colour": "red",
                                                "data": {"anything": [1, 2]}}],
                   "nodes": [{"name": "a", "observed": True, "data": {"documentation_ref": "x"}},
                             {"name": "b", "documentation_ref": "y"},
                             {"name": "c", "data": 5},
                             {"name": "d", "values": ["p", "q"]}],
                   "contexts": [{"name": "k", "constant": ["a"]}]})
        joined = "\n".join(g.problems)
        self.assertIn("the graph has unknown key 'scenarios'", joined)
        self.assertIn("group 'g' has unknown key 'colour'", joined)
        self.assertIn("node 'a' has unknown key 'observed'", joined)
        self.assertIn("node 'b' has unknown key 'documentation_ref'", joined)
        self.assertIn("node 'c' has data that is not a mapping", joined)
        # categories belong to the Sphinx extension, in data
        self.assertIn("node 'd' has unknown key 'values'", joined)
        self.assertIn("context 'k' has unknown key 'constant'", joined)
        # data itself is kept as written and never inspected
        self.assertEqual(g.nodes["a"]["data"], {"documentation_ref": "x"})
        self.assertEqual(g.groups["g"]["data"], {"anything": [1, 2]})
        self.assertEqual(len([p for p in g.problems if "'anything'" in p]), 0)

    def test_malformed_entries_do_not_crash(self):
        g = graph({"groups": ["notamapping"], "nodes": [{"label": "no name"}, 7]})
        self.assertEqual(len(g.problems), 3)

    def test_top_level_not_mapping(self):
        with self.assertRaises(GraphError):
            graph(["a", "b"])


class DerivedViewTests(unittest.TestCase):
    def test_io_for_orders_inputs_by_reference(self):
        g = graph(SMALL)
        inputs, outputs = g.io_for("late")
        self.assertEqual(inputs, ["c", "x"])
        self.assertEqual(outputs, ["d"])
        inputs, outputs = g.io_for("early")
        self.assertEqual(inputs, [])
        self.assertEqual(outputs, ["c"])

    def test_to_json_shape(self):
        j = graph(SMALL).to_json()
        self.assertEqual(j["levelLabels"], ["phase"])
        self.assertEqual(j["groups"]["early"]["contains"], ["b", "a", "g:inner"])
        ids = [n["id"] for n in j["nodes"]]
        self.assertEqual(ids, sorted(ids))
        orders = {n["id"]: n["order"] for n in j["nodes"]}
        self.assertLess(orders["a"], orders["b"])
        self.assertEqual(j["edges"], [{"source": "a", "target": "b"},
                                      {"source": "b", "target": "c"},
                                      {"source": "c", "target": "d"},
                                      {"source": "x", "target": "d"}])
        self.assertEqual(j["correlated"], [["a", "x"]])

    def test_kinds(self):
        g = graph({"groups": [{"name": "g", "contains": ["a", "b", "c"]}],
                   "nodes": [{"name": "a", "observed": True},
                             {"name": "b", "kind": "intervention"},
                             {"name": "c", "kind": "outcome"},
                             {"name": "d", "kind": "sideways"}]})
        self.assertTrue(any("unknown key 'observed'" in p for p in g.problems))
        self.assertTrue(any("kind 'sideways'" in p for p in g.problems))
        kinds = {n["id"]: n["kind"] for n in g.to_json()["nodes"]}
        self.assertEqual(kinds, {"a": None, "b": "intervention", "c": "outcome", "d": "sideways"})
        # only an outcome is an output of its group by itself
        self.assertEqual(g.io_for("g"), ([], ["c"]))

    def test_payload_escapes_script_end(self):
        g = graph({"nodes": [{"name": "a", "label": "</script><b>"}]})
        self.assertNotIn("</script>", g.payload())


class LoadTests(unittest.TestCase):
    def test_missing_and_invalid_files(self):
        with self.assertRaises(GraphError):
            load_graph(Path("/nonexistent/graph.yaml"))
        with tempfile.TemporaryDirectory() as tmp:
            bad = Path(tmp) / "bad.yaml"
            bad.write_text("nodes: [\n", encoding="utf-8")
            with self.assertRaises(GraphError):
                load_graph(bad)
            empty = Path(tmp) / "empty.yaml"
            empty.write_text("", encoding="utf-8")
            self.assertEqual(load_graph(empty).nodes, {})

    def test_reload_on_change(self):
        with tempfile.TemporaryDirectory() as tmp:
            f = Path(tmp) / "g.yaml"
            f.write_text("nodes:\n  - name: a\n", encoding="utf-8")
            first = load_graph(f)
            self.assertIs(load_graph(f), first)
            f.write_text("nodes:\n  - name: a\n  - name: b\n", encoding="utf-8")
            second = load_graph(f)
            self.assertEqual(set(second.nodes), {"a", "b"})


if __name__ == "__main__":
    unittest.main()
