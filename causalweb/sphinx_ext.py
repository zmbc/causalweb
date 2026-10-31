"""Sphinx extension for causal graphs defined in YAML.

Provides two directives:

  .. causal-graph:: path/to/graph.yaml
     :group: pregnancy          # optional: restrict to one subtree
     :collapse: 1               # optional: aggregate to this hierarchy depth
     :height: 700px

  .. causal-graph-table:: pregnancy
     :file: path/to/graph.yaml

The graph is validated whenever it is loaded (acyclicity, dangling references,
unknown groups, duplicate names). Problems are reported as Sphinx warnings, which
fail the build under ``fail_on_warning``.

The rendered graph is interactive, using Cytoscape from a CDN, so it renders in
HTML builders only.

Each graph also gets a whole-window page of its own in ``_static``, which the
widget's "New tab" button links to.

The YAML schema is documented in ``causalweb.model``. This extension reads
one key of its own from a group's or variable's ``data`` mapping:

``documentation_ref``
    The document specifying it: a ``:ref:`` target, or a ``{ref:, text:}``
    mapping to override the link text, or a list of either. A module table's
    "Nested subcomponents" column is the union over its variables', in
    ``contains`` order, deduplicated. Several variables citing one document is
    the normal case, and one variable citing several is too -- a risk-effect
    document describes an edge, so it belongs on the variable the effect is
    applied to.

Enable it with ``extensions = ["causalweb.sphinx_ext"]``. The viewer's CSS
and JS ship inside this package and are added to ``html_static_path`` here, so
the documentation project needs no copy of them.
"""

from __future__ import annotations

import json
from pathlib import Path

from docutils import nodes
from docutils.parsers.rst import Directive, directives
from sphinx.util import logging

from .model import GraphError, _as_list, load_graph
from .page import (CDN_SCRIPTS, LEGEND_HTML, STATIC_DIR, asset_fingerprint,
                   page_html, standalone_name, widget_html)

logger = logging.getLogger(__name__)


def refs_of(item: dict) -> list:
    """The documents a group or variable cites, from ``data.documentation_ref``."""
    data = item.get("data")
    if not isinstance(data, dict):
        return []
    return _as_list(data.get("documentation_ref"))


def ref_problems(graph) -> list[str]:
    """What is wrong with the ``documentation_ref`` entries, if anything."""
    out = []
    for name, item in list(graph.groups.items()) + list(graph.nodes.items()):
        for entry in refs_of(item):
            if isinstance(entry, dict) and "ref" not in entry:
                out.append(f"{name!r} has a documentation_ref mapping with no 'ref' key")
            elif not isinstance(entry, (dict, str)):
                out.append(f"{name!r} has a malformed documentation_ref: {entry!r}")
    return out


def subcomponents_of(graph, group: str) -> list:
    """The documents this group's variables cite, deduplicated.

    A variable names the document that specifies it, and a module's list is
    the union over its variables. Several variables citing one document is
    the normal case -- a cause model specifies its own mortality at both
    neonatal ages -- and one variable citing several is too.
    """
    out, seen = [], set()
    for name in graph.nodes_in(group):
        for entry in refs_of(graph.nodes[name]):
            key = entry["ref"] if isinstance(entry, dict) else entry
            if key not in seen:
                seen.add(key)
                out.append(entry)
    return out


class _GraphDirective(Directive):
    """Shared file resolution for the directives below."""

    def resolve(self, argument: str | None):
        env = self.state.document.settings.env
        option = self.options.get("file") or argument
        if not option:
            option = env.config.causalweb_default_file
        if not option:
            raise GraphError("no graph file given and causalweb_default_file is unset")
        _, filename = env.relfn2path(option)
        path = Path(filename)
        if not path.is_file():
            raise GraphError(f"graph file not found: {option}")
        graph = load_graph(path)
        env.note_dependency(str(path))
        for problem in graph.problems + ref_problems(graph):
            logger.warning("causal graph (%s): %s", path.name, problem,
                           location=(env.docname, self.lineno))
        return graph

    def fail(self, exc: Exception):
        logger.warning("causal graph: %s", exc,
                       location=(self.state.document.settings.env.docname, self.lineno))
        return [nodes.system_message(str(exc), level=2, type="WARNING",
                                     source=self.state.document["source"], line=self.lineno)]


class CausalGraphDirective(_GraphDirective):
    """Render the graph, interactively where the builder supports it."""

    has_content = False
    optional_arguments = 1
    option_spec = {
        "file": directives.unchanged,
        "group": directives.unchanged,
        "collapse": directives.nonnegative_int,
        "height": directives.unchanged,
    }

    def run(self):
        try:
            graph = self.resolve(self.arguments[0] if self.arguments else None)
        except GraphError as exc:
            return self.fail(exc)

        group = self.options.get("group")
        if group and group not in graph.groups:
            return self.fail(GraphError(f"unknown group {group!r}"))

        collapse = self.options.get("collapse")
        payload = graph.payload(group)
        height = self.options.get("height", "640px")
        uid = f"cg{abs(hash((group, collapse, str(graph.source)))):x}"
        env = self.state.document.settings.env
        page = standalone_name(graph.source, group)
        _pages(env).setdefault(env.docname, {})[page] = (payload, collapse)
        # The page is versioned like the assets it loads, so a rebuilt graph is
        # never served from the browser's cache of the previous one.
        standalone = f"{page}?v={env.config.causalweb_assets}"
        html = widget_html(payload, collapse=collapse, uid=uid,
                           standalone=standalone, height=height)
        return [nodes.raw("", "\n" + html + "\n", format="html")]


class CausalGraphTableDirective(_GraphDirective):
    """Generate the inputs/outputs table for a group's children."""

    has_content = False
    required_arguments = 1
    option_spec = {"file": directives.unchanged}

    def run(self):
        try:
            graph = self.resolve(None)
        except GraphError as exc:
            return self.fail(exc)

        group = self.arguments[0].strip()
        if group not in graph.groups:
            return self.fail(GraphError(f"unknown group {group!r}"))

        children = [c for c in graph.subgroups.get(group) or []
                    if c in graph.groups]
        if not children:
            children = [group]

        child_label = (graph.level_labels[graph.depth_of(children[0])]
                       if graph.depth_of(children[0]) < len(graph.level_labels)
                       else "Group")
        headers = [child_label.capitalize(), "Inputs", "Outputs", "Nested subcomponents"]

        table = nodes.table(classes=["causal-graph-table"])
        group_node = nodes.tgroup(cols=len(headers))
        table += group_node
        # One colspec per column, carrying no width: the HTML writer indexes
        # the column list when it writes each cell, so leaving them out is not
        # an option, and a width would need a `colwidths-given` class before
        # the browser saw it.
        for _ in headers:
            group_node += nodes.colspec()
        head = nodes.thead()
        group_node += head
        head += self._row([nodes.paragraph(text=h) for h in headers])
        body = nodes.tbody()
        group_node += body

        for child in children:
            info = graph.groups[child]
            inputs, outputs = graph.io_for(child)
            name_cell = nodes.paragraph()
            refs = refs_of(info)
            if refs:
                name_cell += self._ref(refs[0], info["label"])
            else:
                name_cell += nodes.Text(info["label"])
            body += self._row([
                name_cell,
                self._bullets(graph.describe(n) for n in inputs),
                self._bullets(graph.describe(n, with_values=True) for n in outputs),
                self._bullets_refs(subcomponents_of(graph, child)),
            ])
        return [table]

    @staticmethod
    def _row(cells):
        row = nodes.row()
        for cell in cells:
            entry = nodes.entry()
            entry += cell
            row += entry
        return row

    @staticmethod
    def _bullets(labels):
        items = list(labels)
        if not items:
            return nodes.paragraph()
        bullet = nodes.bullet_list()
        for text in items:
            item = nodes.list_item()
            item += nodes.paragraph(text=text)
            bullet += item
        return bullet

    def _bullets_refs(self, targets):
        """Bullets of :ref: links.

        An entry is either a bare target (Sphinx supplies the target's own
        title) or a ``{ref:, text:}`` mapping. Use the mapping form for labels
        that have no title or caption of their own -- an implicit reference to
        one of those warns, which fails the build under ``fail_on_warning``.
        """
        if not targets:
            return nodes.paragraph()
        bullet = nodes.bullet_list()
        for entry in targets:
            target = entry["ref"] if isinstance(entry, dict) else entry
            text = entry.get("text") if isinstance(entry, dict) else None
            item = nodes.list_item()
            para = nodes.paragraph()
            para += self._ref(target, text)
            item += para
            bullet += item
        return bullet

    @staticmethod
    def _ref(target, text=None):
        """A :ref: cross-reference.

        With no ``text``, ``refexplicit`` is False so Sphinx substitutes the
        target's own title rather than showing the raw target name.
        """
        from sphinx import addnodes
        pending = addnodes.pending_xref(
            "", refdomain="std", reftype="ref", reftarget=target,
            refexplicit=text is not None, refwarn=True,
        )
        label = text if text is not None else target
        pending += nodes.inline(label, label, classes=["xref", "std", "std-ref"])
        return pending


def _pages(env) -> dict:
    """``{docname: {filename: (payload, collapse)}}`` for the standalone pages.

    Kept on the environment, not in a module global: with a cached doctree the
    directive never runs, and the page still has to be written.
    """
    if not hasattr(env, "causalweb_pages"):
        env.causalweb_pages = {}
    return env.causalweb_pages


def purge_pages(app, env, docname):
    _pages(env).pop(docname, None)


def merge_pages(app, env, docnames, other):
    _pages(env).update(_pages(other))


def write_pages(app, exc):
    """Write one whole-window page per graph into the output ``_static``."""
    if exc is not None or getattr(app.builder, "format", "") != "html":
        return
    static = Path(app.builder.outdir) / "_static"
    fingerprint = app.config.causalweb_assets
    written = {}
    for pages in _pages(app.env).values():
        for name, (payload, collapse) in pages.items():
            written[name] = (payload, collapse)
    if written:
        static.mkdir(parents=True, exist_ok=True)
    for name, (payload, collapse) in written.items():
        (static / name).write_text(
            page_html(payload, collapse=collapse, title="Causal graph",
                      fingerprint=fingerprint),
            encoding="utf-8",
        )


def setup(app):
    app.add_config_value("causalweb_default_file", None, "env")
    app.add_config_value("causalweb_assets", asset_fingerprint(), "env")
    app.add_directive("causal-graph", CausalGraphDirective)
    app.add_directive("causal-graph-table", CausalGraphTableDirective)
    # The assets live in this package. Sphinx copies the contents of every
    # static path into the output's _static, which is where the files below
    # and the whole-window pages expect to find each other.
    static = str(STATIC_DIR)
    if static not in app.config.html_static_path:
        app.config.html_static_path.append(static)
    app.add_css_file("causalweb.css")
    # the query engine first: causalweb.js uses it
    app.add_js_file("causalweb_query.js")
    app.add_js_file("causalweb.js")
    app.connect("env-purge-doc", purge_pages)
    app.connect("env-merge-info", merge_pages)
    app.connect("build-finished", write_pages)
    return {"version": "0.1", "parallel_read_safe": True, "parallel_write_safe": True}
