from pathlib import Path

import pytest

from causalweb.model import CausalGraph, GraphError, load_graph


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


# Validation

def test_small_graph_is_clean():
    g = graph(SMALL)
    assert g.problems == []
    assert g.roots == ["early", "late"]
    assert g.parent_of["inner"] == "early"
    assert g.variable_path("c") == ["early", "inner"]
    assert g.variable_path("x") == []
    assert g.contains["early"] == ["b", "a", "g:inner"]


def test_cycle_reported():
    g = graph({"nodes": [{"name": "a", "caused_by": ["b"]},
                         {"name": "b", "caused_by": ["a"]}]})
    assert any("not acyclic" in p for p in g.problems)


def test_unknown_parent_and_contains():
    g = graph({"groups": [{"name": "g", "contains": ["a", "nope"]}],
               "nodes": [{"name": "a", "caused_by": ["ghost"]}]})
    assert any("unknown parent 'ghost'" in p for p in g.problems)
    assert any("contains unknown 'nope'" in p for p in g.problems)


def test_duplicates_and_clash():
    g = graph({"groups": [{"name": "a"}, {"name": "a"}],
               "nodes": [{"name": "a"}, {"name": "b"}, {"name": "b"}]})
    assert any("duplicate group names" in p for p in g.problems)
    assert any("duplicate node names" in p for p in g.problems)
    assert any("both a group and a variable" in p for p in g.problems)


def test_double_containment():
    g = graph({"groups": [{"name": "g", "contains": ["a"]},
                          {"name": "h", "contains": ["a"]}],
               "nodes": [{"name": "a"}]})
    assert any("contained by both" in p for p in g.problems)


def test_context_and_correlated_checks():
    g = graph({"nodes": [{"name": "a"}, {"name": "b", "caused_by": ["a"]}],
               "correlated": [["a", "zz"], ["a"]],
               "contexts": [{"name": "s", "fixed": ["q"],
                             "inactive_edges": [["b", "a"], ["a"]]}]})
    joined = "\n".join(g.problems)
    assert "unknown variable 'zz'" in joined
    assert "not a [a, b] pair" in joined
    assert "fixes unknown variable 'q'" in joined
    assert "inactive edge 'b' -> 'a', which does not exist" in joined
    assert "not a [source, target] pair" in joined


def test_unknown_keys_and_data():
    g = graph({"scenarios": [], "groups": [{"name": "g", "colour": "red",
                                            "data": {"anything": [1, 2]}}],
               "nodes": [{"name": "a", "observed": True, "data": {"documentation_ref": "x"}},
                         {"name": "b", "documentation_ref": "y"},
                         {"name": "c", "data": 5},
                         {"name": "d", "values": ["p", "q"]}],
               "contexts": [{"name": "k", "constant": ["a"]}]})
    joined = "\n".join(g.problems)
    assert "the graph has unknown key 'scenarios'" in joined
    assert "group 'g' has unknown key 'colour'" in joined
    assert "node 'a' has unknown key 'observed'" in joined
    assert "node 'b' has unknown key 'documentation_ref'" in joined
    assert "node 'c' has data that is not a mapping" in joined
    # categories belong to the Sphinx extension, in data
    assert "node 'd' has unknown key 'values'" in joined
    assert "context 'k' has unknown key 'constant'" in joined
    # data itself is kept as written and never inspected
    assert g.nodes["a"]["data"] == {"documentation_ref": "x"}
    assert g.groups["g"]["data"] == {"anything": [1, 2]}
    assert not [p for p in g.problems if "'anything'" in p]


def test_malformed_entries_do_not_crash():
    g = graph({"groups": ["notamapping"], "nodes": [{"label": "no name"}, 7]})
    assert len(g.problems) == 3


def test_top_level_not_mapping():
    with pytest.raises(GraphError):
        graph(["a", "b"])


# Derived views

def test_to_json_shape():
    j = graph(SMALL).to_json()
    assert j["levelLabels"] == ["phase"]
    assert j["groups"]["early"]["contains"] == ["b", "a", "g:inner"]
    ids = [n["id"] for n in j["nodes"]]
    assert ids == sorted(ids)
    orders = {n["id"]: n["order"] for n in j["nodes"]}
    assert orders["a"] < orders["b"]
    assert j["edges"] == [{"source": "a", "target": "b"},
                          {"source": "b", "target": "c"},
                          {"source": "c", "target": "d"},
                          {"source": "x", "target": "d"}]
    assert j["correlated"] == [["a", "x"]]


def test_kinds():
    g = graph({"groups": [{"name": "g", "contains": ["a", "b", "c"]}],
               "nodes": [{"name": "a"},
                         {"name": "b", "kind": "intervention"},
                         {"name": "c", "kind": "outcome"},
                         {"name": "d", "kind": "sideways"}]})
    assert any("kind 'sideways'" in p for p in g.problems)
    kinds = {n["id"]: n["kind"] for n in g.to_json()["nodes"]}
    assert kinds == {"a": None, "b": "intervention", "c": "outcome", "d": "sideways"}


def test_payload_escapes_script_end():
    g = graph({"nodes": [{"name": "a", "label": "</script><b>"}]})
    assert "</script>" not in g.payload()


# Loading

def test_missing_and_invalid_files(tmp_path):
    with pytest.raises(GraphError):
        load_graph(Path("/nonexistent/graph.yaml"))
    bad = tmp_path / "bad.yaml"
    bad.write_text("nodes: [\n", encoding="utf-8")
    with pytest.raises(GraphError):
        load_graph(bad)
    empty = tmp_path / "empty.yaml"
    empty.write_text("", encoding="utf-8")
    assert load_graph(empty).nodes == {}


def test_reload_on_change(tmp_path):
    f = tmp_path / "g.yaml"
    f.write_text("nodes:\n  - name: a\n", encoding="utf-8")
    first = load_graph(f)
    assert load_graph(f) is first
    f.write_text("nodes:\n  - name: a\n  - name: b\n", encoding="utf-8")
    second = load_graph(f)
    assert set(second.nodes) == {"a", "b"}
