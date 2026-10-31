"""Command line interface.

    causalweb serve graph.yaml          show it in the browser, reloading on change
    causalweb check graph.yaml          validate and list problems
    causalweb build graph.yaml -o x.html  write a self-contained page
    causalweb matrix graph.yaml         print the adjacency matrix
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .model import GraphError, load_graph
from .page import page_html


def _graph_or_exit(path: Path):
    try:
        return load_graph(path)
    except GraphError as exc:
        print(f"causalweb: {exc}", file=sys.stderr)
        raise SystemExit(2)


def cmd_serve(args) -> int:
    from .server import serve
    return serve(args.file, group=args.group, collapse=args.collapse,
                 host=args.host, port=args.port, open_browser=args.open,
                 quiet=not args.verbose)


def cmd_check(args) -> int:
    failed = False
    for path in args.files:
        try:
            graph = load_graph(path)
        except GraphError as exc:
            print(f"{path}: {exc}")
            failed = True
            continue
        if graph.problems:
            failed = True
            print(f"{path}: {len(graph.problems)} problem(s)")
            for problem in graph.problems:
                print(f"  - {problem}")
        else:
            print(f"{path}: OK ({len(graph.nodes)} variables, {len(graph.edges())} edges, "
                  f"{len(graph.groups)} groups)")
    return 1 if failed else 0


def cmd_build(args) -> int:
    graph = _graph_or_exit(args.file)
    for problem in graph.problems:
        print(f"problem: {problem}", file=sys.stderr)
    if args.group and args.group not in graph.groups:
        print(f"causalweb: unknown group {args.group!r}", file=sys.stderr)
        return 2
    html = page_html(graph.payload(args.group), collapse=args.collapse,
                     title=args.title or f"{Path(args.file).name} — causal graph",
                     inline=True)
    out = args.output or Path(args.file).with_suffix(".html")
    Path(out).write_text(html, encoding="utf-8")
    print(f"wrote {out}")
    return 0


def cmd_matrix(args) -> int:
    graph = _graph_or_exit(args.file)
    if args.group and args.group not in graph.groups:
        print(f"causalweb: unknown group {args.group!r}", file=sys.stderr)
        return 2
    mx = graph.matrix(depth=args.depth, group=args.group)
    print(mx.render_text(width=args.width))
    print()
    print("rows cause columns; a number counts variable-level edges, "
          "· marks a causal path with no direct edge, ~ a correlated pair")
    if mx.cyclic:
        print("note: the collapsed graph has a cycle, so some edges sit below the diagonal")
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="causalweb",
        description="Hierarchical causal graphs for simulation models, from YAML.",
    )
    sub = p.add_subparsers(dest="command", required=True)

    s = sub.add_parser("serve", help="show a graph in the browser, reloading when the file changes")
    s.add_argument("file", type=Path)
    s.add_argument("--group", help="show only this group's subtree")
    s.add_argument("--collapse", type=int, metavar="DEPTH",
                   help="start with groups open to this depth (default: every variable)")
    s.add_argument("--host", default="127.0.0.1")
    s.add_argument("--port", type=int, default=None,
                   help="default: 8765, or the next free port above it; 0 picks any free port")
    s.add_argument("--open", action="store_true", help="open the page in a browser")
    s.add_argument("--verbose", action="store_true", help="log every request")
    s.set_defaults(func=cmd_serve)

    c = sub.add_parser("check", help="validate graph files and list their problems")
    c.add_argument("files", type=Path, nargs="+")
    c.set_defaults(func=cmd_check)

    b = sub.add_parser("build", help="write a self-contained HTML page")
    b.add_argument("file", type=Path)
    b.add_argument("-o", "--output", type=Path)
    b.add_argument("--group")
    b.add_argument("--collapse", type=int, metavar="DEPTH")
    b.add_argument("--title")
    b.set_defaults(func=cmd_build)

    m = sub.add_parser("matrix", help="print the adjacency matrix")
    m.add_argument("file", type=Path)
    m.add_argument("--depth", type=int, metavar="DEPTH",
                   help="collapse groups deeper than this (default: every variable)")
    m.add_argument("--group", help="only this group's subtree")
    m.add_argument("--width", type=int, default=36, help="label column width")
    m.set_defaults(func=cmd_matrix)
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
