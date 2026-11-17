"""Tests for the Sphinx extension. Skipped when Sphinx is not installed."""

import io
from pathlib import Path

import pytest

sphinx_application = pytest.importorskip("sphinx.application")

from causalweb import sphinx_ext  # noqa: E402
from causalweb.model import CausalGraph  # noqa: E402

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


def test_categories():
    g = graph({"nodes": [
        {"name": "a", "data": {"categories": ["mild", "severe"]}},
        {"name": "b"},
        {"name": "c", "data": {"categories": "mild"}},
        {"name": "d", "data": {"categories": ["mild", 2]}},
    ]})
    assert sphinx_ext.categories_of(g.nodes["a"]) == ["mild", "severe"]
    assert sphinx_ext.categories_of(g.nodes["b"]) == []
    assert sphinx_ext.categories_of(g.nodes["c"]) == []
    assert g.problems == []
    problems = sphinx_ext.data_problems(g)
    assert len(problems) == 2
    assert "'c' has categories 'mild', which is not a list of strings" in problems


def test_documentation_ref():
    g = graph({"groups": [{"name": "g", "data": {"documentation_ref": {"text": "x"}}}],
               "nodes": [{"name": "a", "data": {"documentation_ref": ["r1", 5]}}]})
    problems = sphinx_ext.data_problems(g)
    assert "'g' has a documentation_ref mapping with no 'ref' key" in problems
    assert "'a' has a malformed documentation_ref: 5" in problems


def test_build(tmp_path):
    src, out = tmp_path / "src", tmp_path / "out"
    src.mkdir()
    (src / "conf.py").write_text('extensions = ["causalweb.sphinx_ext"]\n')
    # e1b is an output of early_one and an input of e_mid
    yaml = NESTED.read_text(encoding="utf-8").replace(
        "  - name: e1b\n    caused_by: [e1a]\n",
        "  - name: e1b\n    caused_by: [e1a]\n    data:\n      categories: [low, high]\n")
    assert "categories" in yaml
    (src / "graph.yaml").write_text(yaml, encoding="utf-8")
    (src / "index.rst").write_text(INDEX)
    warnings = io.StringIO()
    app = sphinx_application.Sphinx(
        str(src), str(src), str(out), str(tmp_path / "doctrees"),
        "html", status=None, warning=warnings, freshenv=True)
    app.build()
    assert warnings.getvalue() == ""
    html = (out / "index.html").read_text(encoding="utf-8")
    assert (out / "_static" / "graph.html").is_file()
    assert (out / "_static" / "causalweb.js").is_file()
    # the viewer shows its "New tab" button only with this attribute
    assert 'data-standalone="graph.html?v=' in html

    tables = html.split('<table class="causal-graph-table')[1:]
    assert len(tables) == 2
    # defaults: the level label of the subgroups, then the fixed names
    for header in ("Step", "Inputs", "Outputs", "Documentation"):
        assert f"<p>{header}</p>" in tables[0]
    for header in ("Part", "Reads", "Writes", "Nested subcomponents"):
        assert f"<p>{header}</p>" in tables[1]
    assert "<p>Documentation</p>" not in tables[1]
    # categories follow the label among the outputs, and not the inputs
    assert tables[0].count("(low | high)") == 1
