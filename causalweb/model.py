"""Causal graphs defined in YAML: loading, validation and derived views.

This module has no dependency on Sphinx or on a browser. The Sphinx directives
live in ``causalweb.sphinx_ext`` and the viewer in ``causalweb.static``;
both read the graph through the ``CausalGraph`` class defined here.

The YAML schema
---------------

Two top-level lists, ``groups`` and ``nodes``, plus optional ``level_labels``,
``correlated`` and ``contexts``.

``groups`` is FLAT. A group lists what it ``contains`` by name -- subgroups and
variables alike, defined further down in the same file -- so depth is unlimited
and uniform, nothing is nested in the file, and there is one way to define a
group. The roots are the groups nothing contains; a variable nothing contains is
cross-cutting and is never folded into a group. One name cannot serve as both a
group and a variable, since ``contains`` names both.

``contains`` order is not cosmetic. It orders a module table's outputs, and
walking it orders the inputs: the group's variables in ``contains`` order, each
one's ``caused_by`` in the order that list gives. A cross-module input therefore
sits where the module reading it puts it, which is the only place that knows what
belongs first -- one global order cannot, since the same variable is read by
several modules that each want it somewhere different.

Keys on a group or a variable:

``label``
    Optional. The default is the name with underscores as spaces and a capital at
    the front, so only acronyms and rewordings need to say anything.
``data``
    Optional mapping for anything a consumer of the graph wants to attach. The
    core does not read it or check what is in it. The Sphinx extension keeps its
    ``documentation_ref`` there, for example.

Keys on a variable only:

``caused_by``
    Its direct causes, defaulting to none. Named for the causal direction rather
    than ``parents``, which would read as containment next to ``contains``.
``deterministic``
    True when the variable is an exact function of its causes. Default False,
    meaning it consumes a random draw that is not represented as a cause. This is
    what lets d-separation account for determinism: fixing a deterministic
    variable's causes fixes the variable.
``kind``
    Optional: ``intervention`` or ``outcome``. Each is drawn with a fill of its
    own. An outcome also counts among its group's outputs in the tables whether
    or not anything downstream consumes it.
``values``
    Optional list of the values a categorical variable takes, shown in the tables.

``contexts`` name what the graph loses in a given context. ``fixed`` lists
variables with no variation in it, which cannot confound anything and are cut
from the graph; ``inactive_edges`` lists edges that carry nothing in it.

Any other key is reported as a problem, so a typo cannot pass as a setting.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

import yaml

_CACHE: dict = {}


def _as_list(value) -> list:
    """A ``ref`` may name one document or several."""
    if value is None:
        return []
    return list(value) if isinstance(value, list) else [value]


def default_label(name: str) -> str:
    """The label a node gets when it does not state one.

    Underscores to spaces and a capital at the front, which is right for most
    names. It cannot produce an acronym, so anything with ANC, LBWSG, IFA/MMS,
    YLDs and the like still says what it wants.
    """
    spaced = str(name).replace("_", " ")
    return spaced[:1].upper() + spaced[1:]


class GraphError(Exception):
    """A causal graph that cannot be loaded at all."""


TOP_KEYS = {"level_labels", "groups", "nodes", "correlated", "contexts"}
GROUP_KEYS = {"name", "label", "contains", "data"}
NODE_KEYS = {"name", "label", "caused_by", "deterministic", "kind", "values", "data"}
CONTEXT_KEYS = {"name", "label", "fixed", "inactive_edges"}


def _named_items(data: dict, key: str, problems: list[str]) -> list[dict]:
    """The entries of a top-level list that are mappings with a ``name``.

    Anything else is reported and skipped, so one malformed entry costs one
    problem rather than the whole graph.
    """
    out = []
    raw = data.get(key)
    if raw is None:
        return out
    if not isinstance(raw, list):
        problems.append(f"{key!r} is not a list")
        return out
    for i, item in enumerate(raw):
        if not isinstance(item, dict) or "name" not in item:
            problems.append(f"{key}[{i}] is not a mapping with a 'name'")
            continue
        out.append(item)
    return out


class CausalGraph:
    """A validated causal graph plus its group hierarchy."""

    def __init__(self, data: dict, source: Path):
        if not isinstance(data, dict):
            raise GraphError(f"{source}: the top level is not a mapping")
        self.source = source
        self.problems: list[str] = []
        raw_groups = _named_items(data, "groups", self.problems)
        raw_nodes = _named_items(data, "nodes", self.problems)
        self.level_labels = [str(x) for x in (data.get("level_labels") or [])]
        self.groups = {str(g["name"]): dict(g) for g in raw_groups}
        self.nodes = {str(n["name"]): dict(n) for n in raw_nodes}
        for holder in (self.groups, self.nodes):
            for name, item in holder.items():
                item.setdefault("label", default_label(name))
                item["label"] = str(item["label"])
        for node in self.nodes.values():
            node["caused_by"] = [str(p) for p in _as_list(node.get("caused_by"))]
        self.correlated = [
            tuple(str(v) for v in pair)
            for pair in (data.get("correlated") or [])
            if isinstance(pair, (list, tuple)) and len(pair) == 2
        ]
        self.contexts = [dict(cx) for cx in (data.get("contexts") or [])
                         if isinstance(cx, dict)]
        self._link_groups(raw_groups)
        self._validate(data, raw_groups, raw_nodes)

    # -- hierarchy ---------------------------------------------------------

    def _link_groups(self, raw_groups: list[dict]) -> None:
        """Split each group's ``contains`` list into subgroups and variables.

        One list holds both, since from a reader's point of view a module
        contains whichever of the two it happens to contain. The order is kept:
        it is what orders a module table's rows and its outputs column.
        """
        self.parent_of: dict[str, str] = {}
        self.subgroups: dict[str, list[str]] = {}
        self.members: dict[str, list[str]] = {}
        self.group_of: dict[str, str] = {}
        # `contains` as written, subgroups keyed ``g:<name>`` and variables by
        # name, minus anything unknown. This is the declaration order that
        # breaks ties wherever the causal structure leaves the order open.
        self.contains: dict[str, list[str]] = {}
        for group in raw_groups:
            name = str(group["name"])
            self.subgroups[name], self.members[name] = [], []
            self.contains[name] = []
            for child in _as_list(group.get("contains")):
                child = str(child)
                if child in self.groups:
                    if child in self.parent_of:
                        self.problems.append(
                            f"group {child!r} is contained by both "
                            f"{self.parent_of[child]!r} and {name!r}"
                        )
                    else:
                        self.parent_of[child] = name
                        self.subgroups[name].append(child)
                        self.contains[name].append(f"g:{child}")
                elif child in self.nodes:
                    if child in self.group_of:
                        self.problems.append(
                            f"variable {child!r} is contained by both "
                            f"{self.group_of[child]!r} and {name!r}"
                        )
                    else:
                        self.group_of[child] = name
                        self.members[name].append(child)
                        self.contains[name].append(child)
                else:
                    self.problems.append(
                        f"group {name!r} contains unknown {child!r}"
                    )
        self.roots = [n for n in self.groups if n not in self.parent_of]

    def path_of(self, group: str | None) -> list[str]:
        """Root-first ancestry of ``group``, including itself.

        An empty path means the node is ungrouped -- a cross-cutting variable
        that is never folded into a group.
        """
        path, seen = [], set()
        while group and group not in seen:
            seen.add(group)
            path.append(group)
            group = self.parent_of.get(group)
        return list(reversed(path))

    def depth_of(self, group: str) -> int:
        return len(self.path_of(group)) - 1

    def variable_path(self, name: str) -> list[str]:
        """Root-first groups a variable sits in. Empty for a cross-cutting one."""
        return self.path_of(self.group_of.get(name))

    def descendant_groups(self, group: str) -> set[str]:
        out, stack = {group}, [group]
        while stack:
            current = stack.pop()
            for child in self.subgroups.get(current) or []:
                if child in self.groups and child not in out:
                    out.add(child)
                    stack.append(child)
        return out

    def nodes_in(self, group: str) -> list[str]:
        """This group's variables and its subgroups', depth first.

        In ``contains`` order throughout, which is what the module tables read.
        """
        out: list[str] = []
        stack = [group]
        while stack:
            current = stack.pop(0)
            out.extend(self.members.get(current) or [])
            stack = (self.subgroups.get(current) or []) + stack
        return out

    # -- validation --------------------------------------------------------

    def _validate(self, data: dict, raw_groups: list[dict],
                  raw_nodes: list[dict]) -> None:
        group_names = [str(g["name"]) for g in raw_groups]
        node_names = [str(n["name"]) for n in raw_nodes]
        for label, names in (("group", group_names), ("node", node_names)):
            duplicates = {n for n in names if names.count(n) > 1}
            if duplicates:
                self.problems.append(
                    f"duplicate {label} names: {sorted(duplicates)}"
                )
        # `contains` names groups and variables in one list, so a name used for
        # both would be ambiguous there.
        clash = set(group_names) & set(node_names)
        if clash:
            self.problems.append(
                f"names used for both a group and a variable: {sorted(clash)}"
            )

        for name in self.groups:
            walker, seen = name, set()
            while walker in self.parent_of:
                if walker in seen:
                    self.problems.append(f"group cycle involving {name!r}")
                    break
                seen.add(walker)
                walker = self.parent_of[walker]

        for name, node in self.nodes.items():
            for parent in node["caused_by"]:
                if parent not in self.nodes:
                    self.problems.append(
                        f"node {name!r} lists unknown parent {parent!r}"
                    )
            if not isinstance(node.get("deterministic", False), bool):
                self.problems.append(
                    f"node {name!r} has a non-boolean deterministic: "
                    f"{node.get('deterministic')!r}"
                )
            kind = node.get("kind")
            if kind is not None and kind not in ("intervention", "outcome"):
                self.problems.append(
                    f"node {name!r} has kind {kind!r}; it must be "
                    f"'intervention' or 'outcome'"
                )
            values = node.get("values")
            if values is not None and not (
                isinstance(values, list)
                and all(isinstance(v, str) for v in values)
            ):
                self.problems.append(
                    f"node {name!r} has values {values!r}, which is not a "
                    f"list of strings"
                )

        for pair in data.get("correlated") or []:
            if not (isinstance(pair, (list, tuple)) and len(pair) == 2):
                self.problems.append(
                    f"correlated entry is not a [a, b] pair: {pair!r}"
                )
                continue
            for v in pair:
                if str(v) not in self.nodes:
                    self.problems.append(
                        f"correlated pair names unknown variable {v!r}"
                    )

        edges = set(self.edges())
        for context in self.contexts:
            label = repr(context.get("name"))
            for held in context.get("fixed") or []:
                if held not in self.nodes:
                    self.problems.append(
                        f"context {label} fixes unknown variable {held!r}"
                    )
            for inactive in context.get("inactive_edges") or []:
                if not (isinstance(inactive, (list, tuple)) and len(inactive) == 2):
                    self.problems.append(
                        f"context {label} has an inactive_edges entry that is "
                        f"not a [source, target] pair: {inactive!r}"
                    )
                    continue
                # An edge that is not in the graph makes the entry a typo or a
                # leftover, either way describing a graph this is not.
                if tuple(inactive) not in edges:
                    self.problems.append(
                        f"context {label} lists inactive edge "
                        f"{inactive[0]!r} -> {inactive[1]!r}, which does not exist"
                    )

        # Keys the schema does not have are reported rather than ignored. The
        # one place for anything else is `data`, which is left alone.
        def unknown(keys, allowed, where):
            for key in keys:
                if key in allowed:
                    continue
                self.problems.append(f"{where} has unknown key {key!r}")
        unknown(data, TOP_KEYS, "the graph")
        for group in raw_groups:
            unknown(group, GROUP_KEYS, f"group {group['name']!r}")
            if "data" in group and not isinstance(group["data"], dict):
                self.problems.append(
                    f"group {group['name']!r} has data that is not a mapping"
                )
        for node in raw_nodes:
            unknown(node, NODE_KEYS, f"node {node['name']!r}")
            if "data" in node and not isinstance(node["data"], dict):
                self.problems.append(
                    f"node {node['name']!r} has data that is not a mapping"
                )
        for context in self.contexts:
            unknown(context, CONTEXT_KEYS, f"context {context.get('name')!r}")

        cycle = self._first_cycle()
        if cycle:
            self.problems.append(f"causal graph is not acyclic: {' -> '.join(cycle)}")

    def _first_cycle(self) -> list[str] | None:
        colour: dict[str, int] = {}
        stack: list[str] = []

        def visit(name: str) -> list[str] | None:
            colour[name] = 1
            stack.append(name)
            for parent in self.nodes.get(name, {}).get("caused_by", ()):
                if parent not in self.nodes:
                    continue
                if colour.get(parent) == 1:
                    return stack[stack.index(parent):] + [parent]
                if colour.get(parent, 0) == 0:
                    found = visit(parent)
                    if found:
                        return found
            colour[name] = 2
            stack.pop()
            return None

        for name in self.nodes:
            if colour.get(name, 0) == 0:
                found = visit(name)
                if found:
                    return found
        return None

    # -- derived views -----------------------------------------------------

    def edges(self) -> list[tuple[str, str]]:
        return [
            (parent, name)
            for name, node in self.nodes.items()
            for parent in node["caused_by"]
            if parent in self.nodes
        ]

    def children_of(self) -> dict[str, list[str]]:
        out: dict[str, list[str]] = {name: [] for name in self.nodes}
        for parent, child in self.edges():
            out[parent].append(child)
        return out

    def describe(self, name: str, with_values: bool = False) -> str:
        node = self.nodes[name]
        label = node["label"]
        if with_values and node.get("values"):
            return f"{label} ({' | '.join(node['values'])})"
        return label

    def io_for(self, group: str) -> tuple[list[str], list[str]]:
        """Variables entering and leaving ``group``.

        A variable is an output if anything outside the group consumes it, or
        if it is an outcome. Without the second half, a variable that exists
        only to be reported (it has no children at all) would silently vanish
        from the group's outputs.
        """
        order = self.nodes_in(group)
        rank = {name: i for i, name in enumerate(order)}
        inside = set(order)
        inputs, outputs = [], []
        for name in order:
            for parent in self.nodes[name]["caused_by"]:
                if parent in self.nodes and parent not in inside:
                    inputs.append(parent)
            if self.nodes[name].get("kind") == "outcome":
                outputs.append(name)
        for parent, child in self.edges():
            if parent in inside and child not in inside:
                outputs.append(parent)
        # Inputs keep the order they were referenced in: the group's variables
        # in `contains` order, each one's `caused_by` in the order that list
        # gives. So a cross-module input sits where the module reading it puts
        # it, which is the only place that knows what belongs first. A single
        # global order cannot do this, since one variable is read by several
        # modules that each want it somewhere different.
        #
        # Outputs are the group's own variables, so `contains` order is both the
        # natural reading order and the editable one.
        return list(dict.fromkeys(inputs)), sorted(set(outputs), key=rank.__getitem__)

    def to_json(self, group: str | None = None) -> dict:
        keep = set(self.nodes_in(group)) if group else set(self.nodes)
        return {
            "levelLabels": self.level_labels,
            "groups": {
                name: {
                    "label": g["label"],
                    "parent": self.parent_of.get(name),
                    "depth": self.depth_of(name),
                    "contains": list(self.contains.get(name) or []),
                }
                for name, g in self.groups.items()
            },
            "nodes": [
                {
                    "id": name,
                    "order": position,
                    "label": n["label"],
                    "group": self.group_of.get(name),
                    "path": self.variable_path(name),
                    "deterministic": bool(n.get("deterministic")),
                    "values": n.get("values"),
                    "kind": n.get("kind"),
                }
                for position, (name, n) in enumerate(self.nodes.items())
                if name in keep
            ],
            "edges": [
                {"source": s, "target": t}
                for s, t in sorted(self.edges())
                if s in keep and t in keep
            ],
            "correlated": [list(p) for p in self.correlated
                           if p[0] in keep and p[1] in keep],
            "contexts": [
                {"name": cx.get("name"), "label": cx.get("label", cx.get("name")),
                 "fixed": [c for c in (cx.get("fixed") or []) if c in keep],
                 "inactiveEdges": [
                     list(e) for e in (cx.get("inactive_edges") or [])
                     if isinstance(e, (list, tuple)) and len(e) == 2
                     and e[0] in keep and e[1] in keep
                 ]}
                for cx in self.contexts
            ],
        }

    def payload(self, group: str | None = None) -> str:
        """The JSON the viewer reads, safe to inline in a ``<script>`` element."""
        text = json.dumps(self.to_json(group), separators=(",", ":"))
        # "</script>" inside the data would end the element early.
        return text.replace("</", "<\\/")

    # -- orderings and the adjacency matrix ---------------------------------

    def topological_order(self) -> list[str]:
        """Variables, causes before effects. Ties keep the order of the file.

        With a cycle (which validation reports) the variables on it come last,
        in file order.
        """
        indegree = {name: 0 for name in self.nodes}
        children = self.children_of()
        for _, child in self.edges():
            indegree[child] += 1
        position = {name: i for i, name in enumerate(self.nodes)}
        ready = sorted((n for n in self.nodes if not indegree[n]), key=position.get)
        out: list[str] = []
        while ready:
            name = ready.pop(0)
            out.append(name)
            for child in children[name]:
                indegree[child] -= 1
                if indegree[child] == 0:
                    ready.append(child)
            ready.sort(key=position.get)
        out.extend(n for n in self.nodes if n not in set(out))
        return out

    def scope_orders(self) -> dict[str, dict[str, int] | None]:
        """Causal order of the siblings in every scope.

        A scope is a group (or ``""`` for the root) and its siblings are the
        subgroups and variables it directly contains. An edge between two
        variables is attributed to the siblings that contain them, which gives
        each scope a small graph of its own. The order of that graph is what
        the viewer uses to keep boxes from interleaving and what the matrix
        uses to keep each group's rows together. A scope whose sibling graph
        has a cycle maps to ``None`` rather than to an arbitrary order.

        Group siblings are keyed ``g:<name>``, so they cannot collide with
        variables of the same name.
        """
        siblings: dict[str, list[str]] = {"": [f"g:{r}" for r in self.roots]}
        siblings[""] += [n for n in self.nodes if n not in self.group_of]
        for name in self.groups:
            siblings[name] = list(self.contains.get(name) or [])

        owner: dict[tuple[str, str], str] = {}
        for parent, keys in siblings.items():
            for key in keys:
                if not key.startswith("g:"):
                    owner[(parent, key)] = key
                    continue
                for var in self.nodes_in(key[2:]):
                    owner[(parent, var)] = key

        orders: dict[str, dict[str, int] | None] = {}
        for parent, keys in siblings.items():
            succ = {k: set() for k in keys}
            indeg = {k: 0 for k in keys}
            for source, target in self.edges():
                a = owner.get((parent, source))
                b = owner.get((parent, target))
                if not a or not b or a == b or b in succ[a]:
                    continue
                succ[a].add(b)
                indeg[b] += 1
            declared = {k: i for i, k in enumerate(keys)}
            queue = [k for k in keys if not indeg[k]]
            order: dict[str, int] = {}
            while queue:
                queue.sort(key=declared.__getitem__)
                k = queue.pop(0)
                order[k] = len(order)
                for m in succ[k]:
                    indeg[m] -= 1
                    if indeg[m] == 0:
                        queue.append(m)
            orders[parent] = order if len(order) == len(keys) else None
        return orders

    def bucket_of(self, name: str, depth: int | None) -> str:
        """Where a variable is drawn with the hierarchy open to ``depth``.

        Groups shallower than ``depth`` are open, so a variable whose path is
        longer than that collapses into the first closed group on it. ``None``
        opens everything, so every variable stands for itself.
        """
        path = self.variable_path(name)
        if depth is not None and len(path) > depth:
            return f"g:{path[depth]}"
        return name

    def matrix(self, depth: int | None = None, group: str | None = None) -> "Matrix":
        """The adjacency matrix of the graph as seen at one level of the hierarchy.

        Rows are causes and columns effects, in the hierarchical causal order
        when there is one (so each group's rows are contiguous) and in a plain
        topological order otherwise. Either way every direct edge lands above
        the diagonal unless the collapsed graph has a cycle, which is then
        exactly what the cells below the diagonal show.
        """
        keep = self.nodes_in(group) if group else list(self.nodes)
        keep_set = set(keep)
        members: dict[str, list[str]] = {}
        for name in keep:
            members.setdefault(self.bucket_of(name, depth), []).append(name)
        bucket_of = {v: b for b, vs in members.items() for v in vs}

        direct: dict[tuple[str, str], list[tuple[str, str]]] = {}
        for s, t in self.edges():
            if s in keep_set and t in keep_set:
                bs, bt = bucket_of[s], bucket_of[t]
                if bs != bt:
                    direct.setdefault((bs, bt), []).append((s, t))

        # Reachability between variables, then lifted to buckets.
        children = self.children_of()
        desc: dict[str, set[str]] = {}

        def descendants(v: str) -> set[str]:
            if v in desc:
                return desc[v]
            desc[v] = set()               # acyclic, so never read back
            out: set[str] = set()
            for c in children[v]:
                out.add(c)
                out |= descendants(c)
            desc[v] = out
            return out

        reach: set[tuple[str, str]] = set()
        for v in keep:
            for d in descendants(v):
                if d in keep_set and bucket_of[d] != bucket_of[v]:
                    reach.add((bucket_of[v], bucket_of[d]))

        correlated: set[tuple[str, str]] = set()
        for a, b in self.correlated:
            if a in keep_set and b in keep_set and bucket_of[a] != bucket_of[b]:
                correlated.add((bucket_of[a], bucket_of[b]))
                correlated.add((bucket_of[b], bucket_of[a]))

        buckets = list(members)
        order, cyclic = self._bucket_order(buckets, set(direct))
        labels = {
            b: (self.groups[b[2:]]["label"] if b.startswith("g:") else self.nodes[b]["label"])
            for b in buckets
        }
        return Matrix(order=order, labels=labels, members=members,
                      direct=direct, reach=reach, correlated=correlated,
                      cyclic=cyclic)

    def _bucket_order(self, buckets: list[str],
                      edges: set[tuple[str, str]]) -> tuple[list[str], bool]:
        orders = self.scope_orders()

        def key(bucket: str) -> list:
            if bucket.startswith("g:"):
                groups = self.path_of(bucket[2:])
                leaf = None
            else:
                groups = self.variable_path(bucket)
                leaf = bucket
            ranks: list = []
            parent = ""
            for g in groups:
                scope = orders.get(parent)
                ranks.append(scope.get(f"g:{g}", 0) if scope else 0)
                parent = g
            if leaf is not None:
                scope = orders.get(parent)
                ranks.append(scope.get(leaf, 0) if scope else 0)
            return ranks

        complete = all(orders.get(p) is not None for p in orders)
        hierarchical = sorted(buckets, key=lambda b: (key(b), b))
        if complete:
            pos = {b: i for i, b in enumerate(hierarchical)}
            if all(pos[s] < pos[t] for s, t in edges):
                return hierarchical, False

        # Plain topological order, ties broken towards the hierarchical one.
        rank = {b: i for i, b in enumerate(hierarchical)}
        indeg = {b: 0 for b in buckets}
        succ: dict[str, list[str]] = {b: [] for b in buckets}
        for s, t in edges:
            succ[s].append(t)
            indeg[t] += 1
        ready = sorted((b for b in buckets if not indeg[b]), key=rank.get)
        out: list[str] = []
        while ready:
            b = ready.pop(0)
            out.append(b)
            for t in succ[b]:
                indeg[t] -= 1
                if indeg[t] == 0:
                    ready.append(t)
            ready.sort(key=rank.get)
        left = [b for b in hierarchical if b not in set(out)]
        return out + left, bool(left)


@dataclass
class Matrix:
    """An adjacency matrix over buckets (variables or collapsed groups)."""

    order: list[str]
    labels: dict[str, str]
    members: dict[str, list[str]]
    # (source bucket, target bucket) -> the variable-level edges behind the cell
    direct: dict[tuple[str, str], list[tuple[str, str]]]
    # bucket pairs joined by some directed path, direct or not
    reach: set[tuple[str, str]]
    # bucket pairs declared correlated, both ways round
    correlated: set[tuple[str, str]]
    # whether the collapsed graph has a cycle, so some edges sit below the diagonal
    cyclic: bool = False
    extras: dict = field(default_factory=dict)

    def count(self, s: str, t: str) -> int:
        return len(self.direct.get((s, t), ()))

    def render_text(self, width: int = 36) -> str:
        """A fixed-width rendering for the terminal.

        A number is how many variable-level edges run from the row to the
        column, ``·`` marks a causal path with no direct edge, ``~`` a
        correlated pair, and ``\\`` the diagonal. The last two columns are the
        row's out-degree and in-degree, in edges.
        """
        n = len(self.order)
        cell = 3 if any(len(v) > 9 for v in self.direct.values()) else 2
        idx_w = len(str(n))
        lines = []
        header = " " * (idx_w + 1 + width + 1)
        header += "".join(str(i + 1).rjust(cell) for i in range(n))
        header += "   out  in"
        lines.append(header)
        indeg = {b: 0 for b in self.order}
        outdeg = {b: 0 for b in self.order}
        for (s, t), es in self.direct.items():
            outdeg[s] += len(es)
            indeg[t] += len(es)
        for i, s in enumerate(self.order):
            label = self.labels[s]
            if len(label) > width:
                label = label[: width - 1] + "…"
            row = f"{str(i + 1).rjust(idx_w)} {label.ljust(width)} "
            for j, t in enumerate(self.order):
                if i == j:
                    mark = "\\"
                elif (s, t) in self.direct:
                    mark = str(len(self.direct[(s, t)]))
                elif (s, t) in self.correlated:
                    mark = "~"
                elif (s, t) in self.reach:
                    mark = "·"
                else:
                    mark = ""
                row += mark.rjust(cell)
            row += f"   {str(outdeg[s]).rjust(3)} {str(indeg[s]).rjust(3)}"
            lines.append(row)
        return "\n".join(lines)


def load_graph(path: Path) -> CausalGraph:
    """Load and validate a graph, reusing the last load while the file is unchanged.

    Raises ``GraphError`` when the file cannot be read or parsed, or is so far
    from the schema that no graph can be built from it. Problems that leave a
    graph standing are listed on ``CausalGraph.problems`` instead.
    """
    path = Path(path)
    try:
        stat = path.stat()
    except OSError as exc:
        raise GraphError(f"could not read {path}: {exc}") from exc
    key = (str(path), stat.st_mtime_ns, stat.st_size)
    cached = _CACHE.get(key)
    if cached is None:
        try:
            data = yaml.safe_load(path.read_text(encoding="utf-8"))
        except yaml.YAMLError as exc:
            raise GraphError(f"could not parse {path}: {exc}") from exc
        except OSError as exc:
            raise GraphError(f"could not read {path}: {exc}") from exc
        if data is None:
            data = {}
        try:
            cached = CausalGraph(data, path)
        except GraphError:
            raise
        except Exception as exc:  # a shape the validator did not anticipate
            raise GraphError(f"could not build a graph from {path}: {exc!r}") from exc
        _CACHE.clear()
        _CACHE[key] = cached
    return cached
