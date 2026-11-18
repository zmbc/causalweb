"""Sphinx extension for causal graphs defined in YAML.

Provides two directives:

  .. causalweb-interactive:: path/to/graph.yaml
     :group: some_group         # optional: restrict to one subtree
     :collapse: 1               # optional: aggregate to this hierarchy depth
     :height: 700px

  .. causalweb-table:: some_group
     :file: path/to/graph.yaml
     :group-header: Module             # optional: each header can be replaced
     :inputs-header: Inputs
     :outputs-header: Outputs
     :documentation-header: Documentation

The table has one row for each subgroup of the group. A group with no
subgroups gets one row for itself. The columns are the
subgroup, its inputs, its outputs, and its documentation. The first header
defaults to the level label of the subgroups, or "Group" when there is no
level label. The other headers default to the values shown above.

The graph is validated whenever it is loaded (acyclicity, dangling references,
unknown groups, duplicate names). Problems are reported as Sphinx warnings, which
fail the build under ``fail_on_warning``.

The rendered graph is interactive, using Cytoscape from a CDN, so it renders in
HTML builders only.

Each graph also gets a whole-window page of its own in ``_static``, which the
widget's "New tab" button links to.

The YAML schema is documented in ``causalweb.model``. This extension reads
three keys of its own from a group's or variable's ``data`` mapping:

``documentation_ref``
    The document specifying it: a ``:ref:`` target, or a ``{ref:, text:}``
    mapping to override the link text, or a list of either. The documentation
    column of a table row is the union over the variables of that subgroup, in
    ``contains`` order, deduplicated. Several variables citing one document is
    the normal case, and one variable citing several is too. A document that
    describes an edge belongs on the variable that the edge points to.
``categories``
    On a variable only: the categories it takes, as a list of strings, if it
    is categorical. A module table lists them after the variable's label in
    its "Outputs" column.
``force_output``
    On a variable only: true to list it among its group's outputs even when
    nothing outside the group consumes it, as for a variable that exists to
    be reported. Default false.

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


def _data_of(item: dict) -> dict:
    data = item.get("data")
    return data if isinstance(data, dict) else {}


def _is_str_list(value) -> bool:
    return isinstance(value, list) and all(isinstance(v, str) for v in value)


def refs_of(item: dict) -> list:
    """The documents a group or variable cites, from ``data.documentation_ref``."""
    return _as_list(_data_of(item).get("documentation_ref"))


def categories_of(node: dict) -> list[str]:
    """The categories a variable takes, from ``data.categories``.

    Empty when there are none, or when they are malformed, which
    ``data_problems`` reports.
    """
    categories = _data_of(node).get("categories")
    return categories if _is_str_list(categories) else []


def forces_output(node: dict) -> bool:
    """Whether a variable is an output of its group whatever consumes it."""
    return _data_of(node).get("force_output") is True


def io_of(graph, group: str) -> tuple[list[str], list[str]]:
    """Variables entering and leaving ``group``, for its row of a table.

    A variable is an output if anything outside the group consumes it, or if
    it has ``force_output``.
    """
    order = graph.nodes_in(group)
    inside = set(order)
    inputs, outputs = [], set()
    for name in order:
        for parent in graph.nodes[name]["caused_by"]:
            if parent in graph.nodes and parent not in inside:
                inputs.append(parent)
        if forces_output(graph.nodes[name]):
            outputs.add(name)
    for parent, child in graph.edges():
        if parent in inside and child not in inside:
            outputs.add(parent)
    # Inputs keep the order they were referenced in: the group's variables
    # in `contains` order, each one's `caused_by` in the order that list
    # gives. So a cross-module input sits where the module reading it puts
    # it, which is the only place that knows what belongs first. One variable
    # is read by several modules that each want it somewhere different.
    #
    # Outputs are the group's own variables, so `contains` order is both the
    # natural reading order and the editable one.
    return list(dict.fromkeys(inputs)), [name for name in order if name in outputs]


def data_problems(graph) -> list[str]:
    """What is wrong with this extension's keys in ``data``, if anything."""
    out = []
    for name, item in list(graph.groups.items()) + list(graph.nodes.items()):
        for entry in refs_of(item):
            if isinstance(entry, dict) and "ref" not in entry:
                out.append(f"{name!r} has a documentation_ref mapping with no 'ref' key")
            elif not isinstance(entry, (dict, str)):
                out.append(f"{name!r} has a malformed documentation_ref: {entry!r}")
    for name, node in graph.nodes.items():
        categories = _data_of(node).get("categories")
        if categories is not None and not _is_str_list(categories):
            out.append(f"{name!r} has categories {categories!r}, which is not "
                       f"a list of strings")
        force = _data_of(node).get("force_output")
        if force is not None and not isinstance(force, bool):
            out.append(f"{name!r} has force_output {force!r}, which is not "
                       f"true or false")
    return out


def documentation_of(graph, group: str) -> list:
    """The documents this group's variables cite, deduplicated.

    A variable names the document that specifies it, and a module's list is
    the union over its variables. Several variables can cite one document,
    and one variable can cite several.
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
        for problem in graph.problems + data_problems(graph):
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
    option_spec = {
        "file": directives.unchanged,
        "group-header": directives.unchanged,
        "inputs-header": directives.unchanged,
        "outputs-header": directives.unchanged,
        "documentation-header": directives.unchanged,
    }

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

        level = graph.depth_of(children[0])
        group_header = (graph.level_labels[level].capitalize()
                        if level < len(graph.level_labels) else "Group")
        headers = [
            self.options.get("group-header", group_header),
            self.options.get("inputs-header", "Inputs"),
            self.options.get("outputs-header", "Outputs"),
            self.options.get("documentation-header", "Documentation"),
        ]

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
            inputs, outputs = io_of(graph, child)
            name_cell = nodes.paragraph()
            refs = refs_of(info)
            if refs:
                name_cell += self._ref(refs[0], info["label"])
            else:
                name_cell += nodes.Text(info["label"])
            body += self._row([
                name_cell,
                self._bullets(graph.nodes[n]["label"] for n in inputs),
                self._bullets(self._with_categories(graph.nodes[n]) for n in outputs),
                self._bullets_refs(documentation_of(graph, child)),
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
    def _with_categories(node):
        categories = categories_of(node)
        if not categories:
            return node["label"]
        return f"{node['label']} ({' | '.join(categories)})"

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

        With no ``text``, ``refexplicit`` is False so Sphinx shows the
        target's own title.
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

    Kept on the environment, which lasts from one build to the next: with a
    cached doctree the directive never runs, and the page still has to be
    written.
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
    app.add_directive("causalweb-interactive", CausalGraphDirective)
    app.add_directive("causalweb-table", CausalGraphTableDirective)
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
