"""The viewer page: markup shared by the Sphinx directive and the CLI.

A graph is shown by one widget, a ``div.causal-graph`` holding the graph's JSON
and a legend, which ``causalweb.js`` turns into the interactive view once
Cytoscape has loaded. The Sphinx directive emits that widget inside a page of
documentation. The whole-window page (the "New tab" target in the docs, and
the page the CLI serves) wraps the same widget in a bare HTML document.
"""

from __future__ import annotations

import hashlib
import html
import json
import re
from pathlib import Path

STATIC_DIR = Path(__file__).parent / "static"
ASSETS = ("causalweb.css", "causalweb_query.js", "causalweb.js")

CDN_SCRIPTS = (
    "https://cdn.jsdelivr.net/npm/cytoscape@3.30.2/dist/cytoscape.min.js",
    # ELK rather than dagre: it is the only layout here that handles compound
    # (nested) nodes while still producing a layered, direction-respecting graph.
    "https://cdn.jsdelivr.net/npm/elkjs@0.9.3/lib/elk.bundled.js",
    # The cytoscape-elk adapter from cytoscape/cytoscape.js-elk pull request 52
    # (opt-in ELK edge geometry, compound graphs included), pinned to the
    # commit of its built bundle. Switch back to the npm release once the pull
    # request is merged and published.
    "https://cdn.jsdelivr.net/gh/zmbc/cytoscape.js-elk"
    "@7629f55449e06888d091c909b60960803e0875f6/dist/cytoscape-elk.js",
)

# Describes the visual encoding. Colour is used only for the top-level group a
# variable belongs to, so it carries no other meaning; every other property is
# encoded with border or fill. Open and closed groups need no key: a box with
# members in it and a dashed node with a "+" explain themselves.
LEGEND_HTML = """  <div class="causal-graph-legend">
    <span><i class="cg-key cg-key-deterministic"></i>deterministic</span>
    <span><i class="cg-key cg-key-intervention"></i>intervention</span>
    <span><i class="cg-key cg-key-outcome"></i>outcome</span>
    <span><i class="cg-key cg-key-causal"></i>causes</span>
    <span><i class="cg-key cg-key-correlated"></i>correlated</span>
  </div>"""


def asset_fingerprint() -> str:
    """Hash of this package's code and static assets.

    Used as a cache-busting query string on the assets, and registered by the
    Sphinx extension as an ``env`` config value so that editing any of it
    invalidates cached doctrees. Without that, Sphinx happily serves HTML built
    by an older version of the directive, and the newer JS then runs against
    markup it does not match.
    """
    digest = hashlib.sha256()
    paths = sorted(Path(__file__).parent.glob("*.py"))
    paths += [STATIC_DIR / name for name in ASSETS]
    for path in paths:
        try:
            digest.update(path.read_bytes())
        except OSError:
            digest.update(b"missing")
    return digest.hexdigest()[:16]


def standalone_name(source: Path, group: str | None) -> str:
    """The filename of a graph's whole-window page, inside ``_static``.

    Named after the graph rather than from ``hash()``, which is salted per
    process: an incremental build reuses cached HTML, so a page name that
    changed between builds would leave that HTML pointing at nothing. A graph
    file whose name matches something in ``html_static_path`` would shadow it,
    which is why the name follows the graph and nothing else.
    """
    def slug(text: str) -> str:
        return re.sub(r"[^a-z0-9_]+", "-", text.lower()).strip("-_")

    parts = [slug(Path(source).stem)] + ([slug(group)] if group else [])
    return ".".join(p for p in parts if p) + ".html"


def widget_html(payload: str, *, collapse: int | None, uid: str | None = None,
                standalone: str | None = None, height: str | None = None) -> str:
    """The ``div.causal-graph`` the viewer script builds the graph into.

    The CDN URLs are handed to the browser as data rather than emitted as
    ``<script>`` tags: nbsphinx loads RequireJS on every documentation page,
    and these are UMD bundles, so a plain tag makes them register as anonymous
    AMD modules and RequireJS throws "Mismatched anonymous define() module".
    ``causalweb.js`` loads them with AMD suppressed instead.
    """
    attrs = ['class="causal-graph"']
    if uid:
        attrs.append(f'id="{html.escape(uid, quote=True)}"')
    attrs.append(f'data-collapse="{"" if collapse is None else collapse}"')
    attrs.append(f"data-scripts='{json.dumps(list(CDN_SCRIPTS))}'")
    if standalone:
        attrs.append(f'data-standalone="{html.escape(standalone, quote=True)}"')
    if height:
        attrs.append(f'style="--cg-height:{html.escape(height, quote=True)}"')
    return (
        f"<div {' '.join(attrs)}>\n"
        f'  <script type="application/json" class="causal-graph-data">{payload}</script>\n'
        f"{LEGEND_HTML}\n"
        f"</div>"
    )


def banner_html(problems: list[str], error: str | None = None,
                source: str | None = None) -> str:
    """What is wrong with the graph, for the top of a served page.

    An ``error`` means no graph could be built from the file as it stands, so
    whatever is drawn below it is the last good version. ``problems`` are
    validation findings on the graph that IS drawn.
    """
    if not problems and not error:
        return ""
    where = f" in {html.escape(source)}" if source else ""
    parts = []
    if error:
        parts.append(
            '<div class="cg-banner cg-banner-error"><strong>Could not load the '
            f"graph{where}.</strong> Showing the last version that loaded."
            f"<pre>{html.escape(error)}</pre></div>"
        )
    if problems:
        items = "".join(f"<li>{html.escape(p)}</li>" for p in problems)
        parts.append(
            '<div class="cg-banner cg-banner-warn"><strong>'
            f"{len(problems)} problem{'s' if len(problems) != 1 else ''}{where}"
            f"</strong><ul>{items}</ul></div>"
        )
    return "\n".join(parts)


LIVE_RELOAD_JS = """(function () {
  var mine = %d;
  var es = new EventSource("events");
  es.onmessage = function (e) {
    if (e.data === "reload") { window.location.reload(); return; }
    var m = /^version (\\d+)$/.exec(e.data);
    if (m && parseInt(m[1], 10) !== mine) window.location.reload();
  };
})();"""


def page_html(payload: str | None, *, collapse: int | None = None,
              title: str = "Causal graph", asset_base: str = "",
              fingerprint: str | None = None, inline: bool = False,
              banner: str = "", live_version: int | None = None) -> str:
    """A whole page holding one graph and nothing else.

    ``asset_base`` is where the CSS and JS are served from, relative to the
    page, unless ``inline`` puts them into the page itself, which makes a
    single file that can be mailed or attached. ``live_version`` adds the
    script that reloads the page when the server reports a newer version.
    """
    fingerprint = fingerprint or asset_fingerprint()
    if inline:
        css = (STATIC_DIR / "causalweb.css").read_text(encoding="utf-8")
        head_assets = f"<style>\n{css}\n</style>"
        scripts = []
        for name in ("causalweb_query.js", "causalweb.js"):
            js = (STATIC_DIR / name).read_text(encoding="utf-8")
            scripts.append(f"<script>\n{js.replace('</script', '<\\/script')}\n</script>")
        tail_assets = "\n".join(scripts)
    else:
        head_assets = (f'<link rel="stylesheet" '
                       f'href="{asset_base}causalweb.css?v={fingerprint}">')
        tail_assets = "\n".join(
            f'<script src="{asset_base}{name}?v={fingerprint}"></script>'
            for name in ("causalweb_query.js", "causalweb.js")
        )
    widget = widget_html(payload, collapse=collapse) if payload is not None else ""
    live = f"<script>{LIVE_RELOAD_JS % live_version}</script>" if live_version is not None else ""
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{html.escape(title)}</title>
{head_assets}
</head>
<body class="cg-standalone">
{banner}
{widget}
{tail_assets}
{live}
</body>
</html>
"""
