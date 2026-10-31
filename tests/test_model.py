import sys
import tempfile
import unittest
import os
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _path  # noqa: E402,F401

from causalweb.model import CausalGraph, GraphError, load_graph  # noqa: E402

# The MNCNH graph lives in the vivarium_research repository. The tests that
# use it look for a checkout beside this one, or at $CAUSALWEB_MNCNH.
MNCNH = Path(os.environ.get(
    "CAUSALWEB_MNCNH",
    Path(__file__).resolve().parents[2] / "vivarium_research/docs/source/models"
    "/concept_models/vivarium_mncnh_portfolio/causal_graph.yaml"))


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
                             {"name": "c", "data": 5}],
                   "contexts": [{"name": "k", "constant": ["a"]}]})
        joined = "\n".join(g.problems)
        self.assertIn("the graph has unknown key 'scenarios'", joined)
        self.assertIn("group 'g' has unknown key 'colour'", joined)
        self.assertIn("node 'a' has unknown key 'observed'", joined)
        self.assertIn("node 'b' has unknown key 'documentation_ref'", joined)
        self.assertIn("node 'c' has data that is not a mapping", joined)
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

    def test_topological_order(self):
        order = graph(SMALL).topological_order()
        pos = {n: i for i, n in enumerate(order)}
        for s, t in graph(SMALL).edges():
            self.assertLess(pos[s], pos[t])

    def test_scope_orders_follow_declaration(self):
        g = graph(SMALL)
        orders = g.scope_orders()
        # x causes d, which is in `late`, so x comes before late at the root
        self.assertEqual(orders[""], {"g:early": 0, "x": 1, "g:late": 2})
        # a causes b, so a comes first even though `contains` lists b first
        self.assertEqual(orders["early"], {"a": 0, "b": 1, "g:inner": 2})


class MatrixTests(unittest.TestCase):
    def test_variable_matrix_is_upper_triangular(self):
        g = graph(SMALL)
        mx = g.matrix()
        pos = {b: i for i, b in enumerate(mx.order)}
        for s, t in mx.direct:
            self.assertLess(pos[s], pos[t])
        self.assertFalse(mx.cyclic)
        self.assertIn(("a", "d"), mx.reach)
        self.assertNotIn(("a", "d"), mx.direct)
        self.assertIn(("a", "x"), mx.correlated)
        self.assertIn(("x", "a"), mx.correlated)

    def test_collapsed_matrix(self):
        g = graph(SMALL)
        mx = g.matrix(depth=0)
        self.assertEqual(mx.order, ["g:early", "x", "g:late"])
        self.assertEqual(mx.count("g:early", "g:late"), 1)
        self.assertEqual(mx.direct[("g:early", "g:late")], [("c", "d")])
        self.assertEqual(mx.members["g:early"], ["a", "b", "c"])
        text = mx.render_text(width=10)
        self.assertIn("Early", text)
        self.assertIn("\\", text)

    def test_cyclic_collapse_is_flagged(self):
        data = {"groups": [{"name": "g", "contains": ["a", "c"]},
                           {"name": "h", "contains": ["b"]}],
                "nodes": [{"name": "a"}, {"name": "b", "caused_by": ["a"]},
                          {"name": "c", "caused_by": ["b"]}]}
        g = graph(data)
        self.assertEqual(g.problems, [])
        mx = g.matrix(depth=0)
        self.assertTrue(mx.cyclic)
        self.assertEqual(set(mx.order), {"g:g", "g:h"})

    @unittest.skipUnless(MNCNH.is_file(), "MNCNH graph not present")
    def test_mncnh_matrices(self):
        g = load_graph(MNCNH)
        self.assertEqual(g.problems, [])
        for depth in (None, 0, 1):
            mx = g.matrix(depth=depth)
            pos = {b: i for i, b in enumerate(mx.order)}
            if not mx.cyclic:
                for s, t in mx.direct:
                    self.assertLess(pos[s], pos[t], (depth, s, t))
            # each top-level group's rows are contiguous
            roots = [(g.path_of(b[2:]) if b.startswith("g:") else g.variable_path(b))
                     for b in mx.order]
            roots = [r[0] if r else "" for r in roots]
            seen, last = set(), None
            for r in roots:
                if r != last:
                    self.assertNotIn(r, seen, (depth, r))
                    seen.add(r)
                last = r


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
