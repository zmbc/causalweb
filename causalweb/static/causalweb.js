/* Interactive causal graph viewer.
 *
 * Each .causal-graph container holds the graph as JSON and a legend. The
 * widget is built only once Cytoscape has loaded. If the scripts fail to load,
 * the container shows the legend and nothing else.
 *
 * Hierarchy is shown by containment: an open group is a labelled box holding its
 * members. Colour separates only a handful of categories, and a graph can have
 * many more groups than that, so colour marks the top-level group alone.
 */
(function () {
  "use strict";

  var PALETTE = ["#4C72B0", "#DD8452", "#55A868", "#C44E52", "#8172B3", "#937860"];

  // Below roughly this zoom, labels stop being readable and nodes get too small
  // to click. Past it, the view pans and keeps this zoom.
  var MIN_LEGIBLE_ZOOM = 0.5;
  var REVEAL_MS = 650;       // how long the group you just acted on stays lit
  // A redraw tweens the graph on screen into its new layout over this long.
  // The edges unfold from straight lines into their routes over the same time.
  var MORPH_MS = 350;
  // Above this share of on-screen nodes disappearing, the new picture is a
  // different one, and a tween into it reads as noise, so the canvases are
  // swapped. Nodes appearing do not count, since they start from
  // the place they came from and the motion reads as an unfold.
  var MORPH_MAX_REMOVED = 0.5;
  // How close to a box's edge, or how far down from its top, a click counts as
  // hitting the box's frame.
  var BOX_EDGE = 14;
  var BOX_TITLE = 26;
  // Tolerance so the border line itself is aimable from either side.
  var BORDER_SLACK = 4;
  // Size of the "open" badge drawn in a closed group's top-right corner, and
  // of the square that counts as hitting it.
  var BADGE = 12;
  var OPEN_HIT = 17;

  /* The badge is an image of its own, so it stays where its hit box is
   * however the label wraps. */
  var PLUS_BADGE = "data:image/svg+xml;utf8," + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16">' +
    '<circle cx="8" cy="8" r="7" fill="#ffffff" stroke="#5a6470" stroke-width="1.2"/>' +
    '<path d="M8 4.3v7.4M4.3 8h7.4" stroke="#33393f" stroke-width="1.7" ' +
    'stroke-linecap="round"/></svg>'
  );

  /* A group and a variable can have the same name. Validation reports that as a
   * problem, but the graph still loads. Cytoscape has one id space, and compound
   * layout needs a group and its members present at the same time. So group ids
   * are prefixed on the way in. */
  function G(name) { return "g:" + name; }
  function isGroupId(id) { return id.slice(0, 2) === "g:"; }
  function groupName(id) { return id.slice(2); }

  function ready(fn) {
    if (document.readyState !== "loading") fn();
    else document.addEventListener("DOMContentLoaded", fn);
  }

  /* ---------------------------------------------------------------- loading */

  /* Load one UMD bundle with AMD suppressed.
   *
   * nbsphinx puts RequireJS on every page. These are UMD bundles, so with a
   * loader present they call define() anonymously and RequireJS throws
   * "Mismatched anonymous define() module". Hiding window.define for the duration
   * of the load makes them fall back to attaching globals, which is what we want.
   * define is always restored, so Jupyter widget output on other pages still works.
   */
  function loadScript(src, done) {
    var saved = window.define;
    var suppress = saved && saved.amd;
    if (suppress) window.define = undefined;
    var el = document.createElement("script");
    el.src = src;
    el.async = false;
    el.crossOrigin = "anonymous";
    function finish(ok) {
      if (suppress) window.define = saved;
      el.onload = el.onerror = null;
      done(ok);
    }
    el.onload = function () { finish(true); };
    el.onerror = function () { finish(false); };
    document.head.appendChild(el);
  }

  function loadAll(sources, done) {
    var i = 0;
    (function next(ok) {
      if (!ok) return done(false);          // a missing CDN leaves the static SVG
      if (i >= sources.length) return done(true);
      loadScript(sources[i++], next);
    })(true);
  }

  /* --------------------------------------------------------------- structure */

  /* Which box a variable is drawn inside, given the set of open groups.
   *
   * A variable is drawn as itself only when every group on its path is open;
   * otherwise it collapses into the outermost group that is still closed. A
   * variable with no group is cross-cutting and always drawn as itself. */
  function bucketFor(data, nodeId, open) {
    var node = data.nodeById[nodeId];
    if (!node) return nodeId;
    var path = node.path || [];
    for (var i = 0; i < path.length; i++) {
      if (!open[path[i]]) return G(path[i]);
    }
    return nodeId;
  }

  function parentFor(data, path, selfId, open) {
    for (var i = path.length - 1; i >= 0; i--) {
      if (open[path[i]] && G(path[i]) !== selfId) return G(path[i]);
    }
    return undefined;
  }

  function childGroupsOf(data, name) {
    return Object.keys(data.groups).filter(function (other) {
      return data.groups[other].parent === name;
    });
  }

  /* Open exactly one level. */
  function openThrough(data, name, open) {
    open[name] = true;
  }

  function closeGroup(data, name, open) {
    delete open[name];
    childGroupsOf(data, name).forEach(function (kid) {
      closeGroup(data, kid, open);
    });
  }

  function keyed(ids) {
    var o = {};
    (ids instanceof Array ? ids : [ids]).forEach(function (id) { o[id] = true; });
    return o;
  }

  /* Causal ordering of siblings within every scope, for ELK partitioning.
   *
   * ELK's INCLUDE_CHILDREN assigns every descendant to a global layer, so two
   * sibling boxes can span overlapping layer ranges and interleave on screen.
   * Pinning each sibling to its own partition forces disjoint bands. Ordering
   * every scope, nested ones too, is what stops nested boxes colliding. The
   * order comes from the graph, so it stays right as the model changes. A
   * scope whose sibling graph has a cycle is left unpartitioned.
   *
   * Returns { parentGroupName ("" at the root): { siblingId: rank } }.
   */
  function scopeOrders(data) {
    var siblings = {};
    function add(parent, key) {
      var p = parent || "";
      (siblings[p] = siblings[p] || []).push(key);
    }
    // Declaration order: the file's order for the roots and for cross-cutting
    // variables, and a group's `contains` list for its members. It breaks the
    // ties below, so the layout and the matrix follow the author's order
    // wherever the causal structure leaves the choice open.
    Object.keys(data.groups).forEach(function (g) {
      if (!data.groups[g].parent) add("", G(g));
    });
    data.nodes.slice().sort(function (a, b) {
      return (a.order || 0) - (b.order || 0);
    }).forEach(function (n) { if (!n.group) add("", n.id); });
    Object.keys(data.groups).forEach(function (g) {
      (data.groups[g].contains || []).forEach(function (key) { add(g, key); });
    });

    // Which sibling each variable sits beneath, so edges between variables can
    // be attributed to the siblings that contain them.
    var owner = {};
    Object.keys(siblings).forEach(function (parent) {
      siblings[parent].forEach(function (key) {
        if (key.slice(0, 2) !== "g:") {
          owner[parent + "|" + key] = key;
          return;
        }
        var g = groupName(key);
        data.nodes.forEach(function (n) {
          if ((n.path || []).indexOf(g) >= 0) owner[parent + "|" + n.id] = key;
        });
      });
    });

    var orders = {};
    Object.keys(siblings).forEach(function (parent) {
      var keys = siblings[parent], declared = {}, edges = [];
      keys.forEach(function (k, i) { declared[k] = i; });
      data.edges.forEach(function (e) {
        var a = owner[parent + "|" + e.source], b = owner[parent + "|" + e.target];
        if (a && b) edges.push([a, b]);
      });
      var sorted = window.CausalGraphQuery.topoOrder(keys, edges, declared);
      var order = {};
      sorted.order.forEach(function (k, i) { order[k] = i; });
      orders[parent] = sorted.left.length ? null : order;
    });
    return orders;
  }

  function openForDepth(data, depth) {
    var open = {};
    Object.keys(data.groups).forEach(function (name) {
      if (depth === null || data.groups[name].depth < depth) open[name] = true;
    });
    return open;
  }

  /* ------------------------------------------------------------- matrix */

  /* The top-level group a bucket belongs to, "" for a cross-cutting variable. */
  function rootOf(data, id) {
    if (isGroupId(id)) {
      var info = data.groups[groupName(id)];
      return (info.path && info.path[0]) || groupName(id);
    }
    var n = data.nodeById[id];
    return (n && n.path && n.path[0]) || "";
  }

  /* A bucket's ranks down its chain of scopes: the root scope first, then
   * each enclosing group's. Sorting by these gives the hierarchical causal
   * order, with every group's members contiguous. */
  function scopeKey(data, orders, id) {
    var groups, leaf;
    if (isGroupId(id)) {
      groups = data.groups[groupName(id)].path || [];
      leaf = null;
    } else {
      var n = data.nodeById[id];
      groups = (n && n.path) || [];
      leaf = id;
    }
    var key = [], parent = "";
    groups.forEach(function (g) {
      var scope = orders[parent];
      key.push(scope && G(g) in scope ? scope[G(g)] : 0);
      parent = g;
    });
    if (leaf !== null) {
      var last = orders[parent];
      key.push(last && leaf in last ? last[leaf] : 0);
    }
    return key;
  }

  function compareKeys(a, b) {
    for (var i = 0; i < Math.min(a.length, b.length); i++) {
      if (a[i] !== b[i]) return a[i] - b[i];
    }
    return a.length - b.length;
  }

  /* Rows and columns of the matrix: causes before effects.
   *
   * The hierarchical causal order is used whenever it is a topological order
   * of the bucket graph, so each group's rows stay together. Otherwise a
   * plain topological order, ties broken towards the hierarchical one. A
   * cycle among collapsed groups leaves its members for the end, where their
   * backward edges land below the diagonal -- the honest picture of it. */
  function bucketOrder(data, buckets, edgeKeys) {
    var orders = data.scopeOrders || (data.scopeOrders = scopeOrders(data));
    var keys = {};
    buckets.forEach(function (b) { keys[b] = scopeKey(data, orders, b); });
    var hier = buckets.slice().sort(function (a, b) {
      return compareKeys(keys[a], keys[b]) || (a < b ? -1 : a > b ? 1 : 0);
    });
    var complete = Object.keys(orders).every(function (p) { return !!orders[p]; });
    var pos = {};
    hier.forEach(function (b, i) { pos[b] = i; });
    var forward = edgeKeys.every(function (e) { return pos[e[0]] < pos[e[1]]; });
    if (complete && forward) return { order: hier, cyclic: false };
    var sorted = window.CausalGraphQuery.topoOrder(buckets, edgeKeys, pos);
    return { order: sorted.order.concat(sorted.left), cyclic: sorted.left.length > 0 };
  }

  /* The picture of the summary `s` (see summarize in causalweb_query.js): its
   * visible variables, each drawn as itself or inside the closed group that
   * holds it, and its edges between them. Two shown nodes are joined by at
   * most one edge of each kind: a direct edge, an edge through hidden
   * variables, and a <->. Each edge lists the summary's edges behind it in
   * `parts`.
   *
   * `nested` draws open groups as compound boxes. It requires a layout that
   * understands compound nodes: without one, boxes have no computed size and
   * pile up on top of each other, which is far worse than showing no boxes at
   * all. So when ELK is unavailable we build the same graph flat. */
  function buildElements(data, open, nested, s, elements) {
    var els = [], seen = {}, needBox = {};
    var orders = nested ? scopeOrders(data) : null;
    // Rank of `key` among its siblings in `parent`'s scope.
    function partitionFor(parent, key) {
      if (!orders) return undefined;
      var scope = orders[parent || ""];
      return scope && key in scope ? scope[key] : undefined;
    }

    s.visible.forEach(function (v) {
      var n = data.nodeById[v];
      if (!n) return;
      var id = bucketFor(data, n.id, open);
      var path = n.path || [];
      if (nested) {
        path.forEach(function (p) {
          if (open[p] && G(p) !== id) needBox[p] = true;
        });
      }
      if (seen[id]) return;
      seen[id] = true;
      var collapsed = id !== n.id;
      els.push({ data: {
        id: id,
        label: collapsed ? data.groups[groupName(id)].label : n.label,
        parent: nested ? parentFor(data, path, id, open) : undefined,
        collapsedGroup: collapsed ? 1 : 0,
        // A collapsed bucket is none of these, so it gets the plain border.
        deterministic: !collapsed && n.deterministic ? 1 : 0,
        kind: collapsed ? null : (n.kind || null),
        colour: PALETTE[(data.rootIndex[path[0] || ""] || 0) % PALETTE.length],
        // A collapsed bucket is ranked in its own group's scope; a variable in
        // the scope of the group it belongs to.
        partition: collapsed
          ? partitionFor(data.groups[groupName(id)].parent, id)
          : partitionFor(n.group, id),
      }});
    });

    Object.keys(needBox).forEach(function (name) {
      var info = data.groups[name];
      var root = (info.path && info.path[0]) || name;
      els.push({ data: {
        id: G(name),
        label: info.label,
        isBox: 1,
        parent: info.parent && open[info.parent] ? G(info.parent) : undefined,
        colour: PALETTE[(data.rootIndex[root] || 0) % PALETTE.length],
        partition: partitionFor(info.parent, G(name)),
      }});
      seen[G(name)] = true;
    });

    var edges = {}, order = [], edgeKeys = [];
    elements(s).forEach(function (e) {
      var a = bucketFor(data, e.source, open), b = bucketFor(data, e.target, open);
      if (a === b) return;
      var prefix = e.kind === "solid" ? "e" : e.kind === "leg" ? "l" : "c";
      // a <-> is one edge whichever way round; it is turned below
      var key = prefix === "c" && b < a ? prefix + b + ">" + a : prefix + a + ">" + b;
      if (!edges[key]) {
        edges[key] = { id: key, source: a, target: b,
                       kind: prefix === "c" ? "correlated" : "causal",
                       contracted: prefix === "l" ? 1 : 0, expandable: 0, parts: [] };
        order.push(key);
        if (prefix !== "c") edgeKeys.push([a, b]);
      }
      edges[key].parts.push(e.id);
      if (e.expandable) edges[key].expandable = 1;
    });

    /* A correlation has no direction, but the layered layout treats every
     * edge as pointing from source to target. Pointing it along the causal
     * order of what is shown keeps it from closing a cycle with the edges,
     * which the layout would break by turning one of them upward. */
    var pos = {};
    if (order.some(function (k) { return k.charAt(0) === "c"; })) {
      var buckets = Object.keys(seen).filter(function (id) {
        return !isGroupId(id) || !needBox[groupName(id)];
      });
      bucketOrder(data, buckets, edgeKeys).order.forEach(function (b, i) { pos[b] = i; });
    }
    order.forEach(function (k) {
      var e = edges[k];
      if (e.kind === "correlated" && pos[e.source] > pos[e.target]) {
        var t = e.source;
        e.source = e.target;
        e.target = t;
        e.id = "c" + e.source + ">" + e.target;
      }
      els.push({ data: e });
    });
    return els;
  }

  /* ------------------------------------------------------------------- style */

  var STYLE = [
    {
      selector: "node",
      style: {
        label: "data(label)",
        "text-wrap": "wrap",
        "text-max-width": 100,
        "font-size": 9,
        "text-valign": "center",
        shape: "round-rectangle",
        width: "label",
        height: "label",
        padding: 5,
        "background-color": "#ffffff",
        "border-color": "data(colour)",
        "border-width": 1,
        color: "#222222",
        // Cytoscape draws a translucent grey overlay on tap by default.
        "overlay-opacity": 0,
        "transition-property": "border-width border-color background-color",
        "transition-duration": "150ms",
      },
    },
    { selector: "node[deterministic = 1]", style: { "border-width": 2.5 } },
    { selector: 'node[kind = "outcome"]', style: { "background-color": "#eef3fa" } },
    { selector: 'node[kind = "intervention"]', style: { "background-color": "#e8f3e8" } },
    {
      selector: "node[collapsedGroup = 1]",
      style: {
        "border-style": "dashed",
        "border-width": 2,
        "font-weight": "bold",
        // The badge sits inside the top-right corner. Uniform padding of at
        // least the badge size clears it on both axes -- the label's right
        // edge stops at x2-padding and its top at y1+padding -- so the text
        // stays centred.
        padding: BADGE + 1,
        "background-image": PLUS_BADGE,
        "background-image-containment": "over",
        "background-clip": "none",
        "background-width": BADGE + "px",
        "background-height": BADGE + "px",
        "background-position-x": "100%",
        "background-position-y": "0%",
        "background-repeat": "no-repeat",
        "background-image-opacity": 1,
      },
    },
    // An open group: a tinted box with its name at the top. Top padding has to
    // clear the label, or members collide with it.
    {
      selector: "node[isBox = 1]",
      style: {
        "text-valign": "top",
        "text-halign": "center",
        // text-valign:top centres the label ON the top border. Padding opens a
        // band between the frame and the members; the label sits in that band,
        // clear of both. (Cytoscape compound padding is uniform, so the sides
        // widen too -- harmless.)
        "text-margin-y": 13,
        "font-size": 11,
        "font-weight": "bold",
        // Group names are short; let them stay on one line. A wrapped title is
        // taller than the padding band reserves and spills over the frame.
        "text-max-width": 260,
        padding: 24,
        "background-opacity": 0.07,
        "background-color": "data(colour)",
        "border-width": 1,
        "border-style": "solid",
        "border-color": "data(colour)",
        color: "#333333",
      },
    },
    {
      selector: "edge",
      style: {
        width: 1,
        "line-color": "#b3b8bd",
        "target-arrow-color": "#b3b8bd",
        "target-arrow-shape": "triangle",
        "arrow-scale": 0.7,
        // The fallback only: ELK's own routes are written onto the edges as
        // segment geometry by the layout (see LAYOUT_ELK), and avoid the
        // boxes. Cytoscape's taxi routing does not, so it is not used.
        "curve-style": "bezier",
        "overlay-opacity": 0,
        "transition-property": "line-color width target-arrow-color",
        "transition-duration": "120ms",
      },
    },
    {
      selector: 'edge[kind = "correlated"]',
      style: {
        "line-style": "dashed",
        "source-arrow-shape": "triangle",
        "line-color": "#c9868a",
        "target-arrow-color": "#c9868a",
        "source-arrow-color": "#c9868a",
      },
    },
    // An edge that stands for routes through hidden variables is dotted; an
    // edge of the model is solid.
    {
      selector: "edge[contracted = 1]",
      style: { "line-style": "dotted" },
    },
    /* An edge is explained in its tooltip: with a dozen edges among five
     * nodes, labels along the lines would rotate and collide. */
    // Suppress the grey puck Cytoscape paints where you tap empty canvas.
    { selector: "core", style: { "active-bg-opacity": 0, "active-bg-size": 0 } },
    { selector: ".dimmed", style: { opacity: 0.12 } },
    { selector: ".picked", style: { "border-width": 4, "background-color": "#fff3cd" } },
    // Hover: pull the touched edges out of the thicket.
    {
      selector: "edge.hovered",
      style: {
        width: 2.4,
        "line-color": "#1f6feb",
        "target-arrow-color": "#1f6feb",
        "source-arrow-color": "#1f6feb",
        "z-index": 20,
        opacity: 1,
      },
    },
    { selector: "node.hovered", style: { "border-color": "#1f6feb", "border-width": 2.5 } },
    // The group just opened or closed, briefly, so the change is easy to find.
    {
      selector: "node.revealed",
      style: { "background-color": "#e6f6ea", "border-color": "#2da44e",
               "border-width": 2.5 },
    },
    // A box is mostly transparent, so its frame carries the tint.
    {
      selector: "node[isBox = 1].revealed",
      style: { "border-color": "#2da44e", "border-width": 2.5,
               "background-color": "#2da44e", "background-opacity": 0.13 },
    },
  ];

  var LAYOUT_ELK = {
    name: "elk",
    // ELK routes the edges as well as placing the nodes, and the adapter
    // writes each route onto its edge as segment geometry (a per-edge style
    // bypass), with rounded bends. The stylesheet's bezier is what an edge
    // falls back to when ELK gives it no route.
    useElkEdgeGeometry: true,
    elkEdgeRadius: 6,
    elk: {
      algorithm: "layered",
      "elk.edgeRouting": "ORTHOGONAL",
      // Vertical. Measured on this graph, LR comes out 6.3:1 and needs about as
      // much panning as DOWN even on a landscape screen -- and LR additionally
      // makes sibling group boxes interleave at full expansion.
      "elk.direction": "DOWN",
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
      "elk.partitioning.activate": "true",
      // Generous enough that sibling boxes keep a visible gap. Boxes flush
      // against each other read as an overlap.
      "elk.spacing.nodeNode": 28,
      "elk.layered.spacing.nodeNodeBetweenLayers": 50,
      "elk.spacing.edgeNode": 16,
      "elk.spacing.edgeEdge": 10,
      "elk.spacing.componentComponent": 50,
      // These insets MUST be at least the compound `padding` in STYLE below.
      // Cytoscape sizes a box as its children plus that padding; ELK only
      // reserves what it is told here. If padding is the larger of the two,
      // every box is drawn wider than the space allotted to it and siblings
      // collide -- and the error compounds with nesting depth.
      "elk.padding": "[top=32,left=24,bottom=24,right=24]",
    },
    fit: false,
    padding: 16,
  };

  // Compound boxes are only drawn when a compound-aware layout is present.
  function canNest() { return !!window.cytoscapeElk; }

  /* Whether a click landed on a box's frame: its border or its title
   * strip. */
  function within(bb, pos, slack) {
    slack = slack || 0;
    return pos.x >= bb.x1 - slack && pos.x <= bb.x2 + slack &&
           pos.y >= bb.y1 - slack && pos.y <= bb.y2 + slack;
  }

  function onBoxFrame(node, pos) {
    if (!pos) return false;
    var bb = node.boundingBox();
    // Inside (or just outside) first. Proximity alone is not enough: a point
    // far to the left of the box also satisfies "within BOX_EDGE of the left
    // border". The slack lets you aim at the border line itself.
    if (!within(bb, pos, BORDER_SLACK)) return false;
    return (pos.x - bb.x1) < BOX_EDGE ||
           (bb.x2 - pos.x) < BOX_EDGE ||
           (bb.y2 - pos.y) < BOX_EDGE ||
           (pos.y - bb.y1) < BOX_TITLE;
  }

  /* A closed group carries a "+" badge in its top-right corner. Hitting that
   * opens the group; hitting anywhere else highlights it like any other node,
   * so a group can be inspected without being taken apart. */
  function onOpenAffordance(node, pos) {
    if (!pos) return false;
    var bb = node.boundingBox();
    if (!within(bb, pos)) return false;
    return (bb.x2 - pos.x) < OPEN_HIT && (pos.y - bb.y1) < OPEN_HIT;
  }

  /* ELK runs offstage, on a shadow copy of the graph, and the live graph is
   * then tweened into the finished result (see morph). The continuity comes
   * from the tween. */
  function layoutOptions() {
    var opts = canNest() ? LAYOUT_ELK
                         : { name: "breadthfirst", fit: false, directed: true,
                             spacingFactor: 1.3 };
    var merged = {};
    Object.keys(opts).forEach(function (k) { merged[k] = opts[k]; });
    merged.animate = false;
    // Per-node ELK options; see scopeOrders for why siblings are
    // pinned to partitions.
    merged.nodeLayoutOptions = function (node) {
      var opts = {};
      var p = node.data("partition");
      if (p !== undefined && p !== null) {
        opts["elk.partitioning.partition"] = String(p);
      }
      // partitioning.activate applies to the node whose CHILDREN are being
      // partitioned, so every box needs it -- setting it only on the root
      // graph orders the top-level boxes and nothing nested inside them.
      if (node.isParent()) opts["elk.partitioning.activate"] = "true";
      return opts;
    };
    return merged;
  }

  /* -------------------------------------------------------------------- dom */

  function control(tag, attrs, text) {
    var el = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { el.setAttribute(k, attrs[k]); });
    if (text) el.textContent = text;
    return el;
  }

  function scriptBase() {
    var el = document.querySelector('script[src*="causalweb.js"]');
    return el ? el.src.replace(/causalweb\.js.*$/, "") : "";
  }

  /* This graph's whole-window page, written into _static by the Sphinx build
   * and named in data-standalone. It is a page of its own, so it survives a
   * reload of the tab, a bookmark, and sphinx-autobuild refreshing the page
   * behind it. The view state rides along in the
   * fragment (see viewHash) so the bigger view starts where the reader left
   * off. */
  function standaloneUrl(container, hash) {
    var name = container.getAttribute("data-standalone");
    if (!name) return null;
    return scriptBase() + name + hash;
  }

  /* The fragment for a view: the open groups, the variables the filter
   * shows when it is on (`show`, which may be empty), its context, and
   * whether open groups are drawn as boxes. */
  function viewHash(data, open, shown, context, boxes) {
    function list(ids) { return ids.map(encodeURIComponent).join(","); }
    var groups = Object.keys(open).filter(function (g) { return open[g]; });
    var parts = ["open=" + list(groups)];
    if (shown) {
      parts.push("show=" + list(data.nodes.map(function (n) { return n.id; })
        .filter(function (id) { return shown[id]; })));
    }
    if (shown && context) parts.push("cx=" + encodeURIComponent(context));
    if (!boxes) parts.push("boxes=0");
    return "#" + parts.join("&");
  }

  function hashParam(name) {
    var re = new RegExp("(?:^|[#&])" + name + "=([^&]*)");
    var match = re.exec(window.location.hash || "");
    return match ? match[1] : null;
  }

  /* The view state carried in the fragment (see viewHash). "New tab" hands
   * it over this way, and the whole-window page keeps it current, so a reload
   * -- the live-reloading server does one on every edit -- comes back to the
   * same view. Section anchors cannot collide with any of this: they carry no
   * "=". */
  function stateFromHash(data) {
    var state = { open: null, shown: null, cx: null, boxes: hashParam("boxes") !== "0" };
    function ids(text) {
      return text.split(",").map(decodeURIComponent).filter(function (id) {
        return !!data.nodeById[id];
      });
    }
    var open = hashParam("open");
    if (open !== null) {
      state.open = {};
      open.split(",").forEach(function (part) {
        var name = decodeURIComponent(part);
        if (name && data.groups[name]) state.open[name] = true;
      });
    }
    var show = hashParam("show");
    if (show !== null) state.shown = keyed(ids(show));
    var cx = hashParam("cx");
    if (cx !== null) {
      cx = decodeURIComponent(cx);
      if ((data.contexts || []).some(function (c2) { return c2.name === cx; })) {
        state.cx = cx;
      }
    }
    return state;
  }

  /* -------------------------------------------------------------------- init */

  function init(container) {
    var script = container.querySelector("script.causal-graph-data");
    if (!script || typeof window.cytoscape === "undefined") return;

    var data;
    try {
      data = JSON.parse(script.textContent);
    } catch (err) {
      return;
    }
    if (window.cytoscapeElk) window.cytoscape.use(window.cytoscapeElk);

    data.nodeById = {};
    data.nodes.forEach(function (n) { data.nodeById[n.id] = n; });
    // colour index per top-level group
    data.rootIndex = {};
    data.nodes.forEach(function (n) {
      var root = (n.path && n.path[0]) || "";
      if (!(root in data.rootIndex)) {
        data.rootIndex[root] = Object.keys(data.rootIndex).length;
      }
    });
    // group -> its own root-first path, for colouring boxes
    Object.keys(data.groups).forEach(function (name) {
      var path = [], walk = name;
      while (walk) { path.unshift(walk); walk = data.groups[walk].parent; }
      data.groups[name].path = path;
    });

    var maxDepth = 0;
    data.nodes.forEach(function (n) {
      if (n.path && n.path.length > maxDepth) maxDepth = n.path.length;
    });

    var preset = container.getAttribute("data-collapse");
    var saved = stateFromHash(data);
    var open = saved.open || openForDepth(
      data, preset === "" || preset === null ? null : parseInt(preset, 10)
    );

    /* The controls: a button for each level of groups, Group boxes, Filter
     * and New tab. */
    var bar = control("div", { class: "causal-graph-controls" });
    var presetBar = control("span", { class: "cg-presets" });
    var presets = [];
    for (var d = 0; d < maxDepth; d++) {
      presets.push([d, data.levelLabels[d] ? "By " + data.levelLabels[d]
                                           : "Level " + (d + 1)]);
    }
    presets.push([null, "Every variable"]);
    presets.forEach(function (entry) {
      var btn = control("button", { type: "button" }, entry[1]);
      btn.addEventListener("click", function () {
        open = openForDepth(data, entry[0]);
        draw();
      });
      presetBar.appendChild(btn);
    });

    // Open groups drawn as boxes around their members, or left out.
    var boxesBox = control("input", { type: "checkbox" });
    boxesBox.checked = saved.boxes;
    var boxesToggle = control("label", { class: "cg-toggle" });
    boxesToggle.appendChild(boxesBox);
    boxesToggle.appendChild(document.createTextNode("Group boxes"));
    // Pressed, the filter is on and its section shows under the bar.
    var filterBtn = control("button",
      { type: "button", "aria-pressed": "false",
        title: "Show only the variables checked, in a context" }, "Filter");
    // Undo sits in the filter's section, beside Reset.
    var undoBtn = control("button",
      { type: "button", title: "Undo the last change to the variables shown" }, "Undo");
    var newTab = control("button", { type: "button", title: "Open in a new tab" }, "New tab");
    [presetBar, boxesToggle, filterBtn, newTab]
      .forEach(function (el) { bar.appendChild(el); });
    // nothing to open from the whole-window page: it is already that page
    if (!container.getAttribute("data-standalone")) newTab.hidden = true;

    var panel = control("div", { class: "causal-graph-panel", hidden: "hidden" });

    // Two stacked canvases: the next graph is built and laid out in the hidden
    // one, then swapped in. Rebuilding in place blanks the view for as long as
    // the layout takes, which reads as a flicker on every click.
    var stage = control("div", { class: "causal-graph-stage" });
    // The graph's own column: its canvases, with its legend under them. The
    // matrix pane is a column of the same shape beside it, so each side's
    // legend sits under its own picture.
    var graphCol = control("div", { class: "cg-graph" });
    var canvasesWrap = control("div", { class: "cg-canvases" });
    var canvases = [
      control("div", { class: "causal-graph-canvas" }),
      control("div", { class: "causal-graph-canvas cg-offstage" }),
    ];
    canvases.forEach(function (el) { canvasesWrap.appendChild(el); });
    graphCol.appendChild(canvasesWrap);
    stage.appendChild(graphCol);
    /* The tooltip of both panes. It lives on the stage, above both canvases,
     * so it survives the swap between them, and the matrix's scrolling does
     * not clip it. The canvases start at the stage's corner, so a position
     * against them is one against the stage. */
    var tip = control("div", { class: "cg-tip" });
    tip.hidden = true;
    stage.appendChild(tip);
    var mxPane = control("div", { class: "cg-matrix" });
    // The table scrolls inside this; the pane's legend sits below it, still.
    var mxScroll = control("div", { class: "cg-matrix-scroll" });
    mxPane.appendChild(mxScroll);
    stage.appendChild(mxPane);
    var canvas = canvases[0];      // the one currently on screen
    var legend = container.querySelector(".causal-graph-legend");
    [bar, panel, stage].forEach(function (el) {
      if (legend) container.insertBefore(el, legend);
      else container.appendChild(el);
    });

    var modelLegend = container.querySelector(".causal-graph-legend");
    if (modelLegend) graphCol.appendChild(modelLegend);

    /* A legend built here. Each entry is [key class, text]. */
    function makeLegend(cls, entries, note) {
      var el = control("div", { class: cls });
      entries.forEach(function (k) {
        var span = control("span", {});
        span.appendChild(control("i", { class: "cg-key " + k[0] }));
        span.appendChild(document.createTextNode(k[1]));
        el.appendChild(span);
      });
      if (note) el.appendChild(control("span", { class: "cg-legend-note" }, note));
      el.hidden = true;
      return el;
    }

    /* The matrix's keys sit in the matrix pane, under the table. */
    var matrixLegend = makeLegend("causal-graph-legend cg-matrix-legend", [
      ["cg-key-mx-direct", "direct edge"],
      ["cg-key-mx-leg", "path through hidden variables"],
      ["cg-key-mx-both", "both"],
      ["cg-key-mx-reach", "causal path through the variables shown"],
      ["cg-key-mx-corr", "correlated"],
      ["cg-key-mx-far", "correlated through the variables shown"]],
      "matrix: rows cause columns, in causal order");
    mxPane.appendChild(matrixLegend);

    /* Show a legend when `on`, with only the entries whose key class is set
     * in `present`. A legend left with no entries and no note is hidden. */
    function fitLegend(el, on, present) {
      if (!el) return;
      var shown = 0;
      Array.prototype.forEach.call(el.querySelectorAll("i.cg-key"), function (key) {
        var drawn = Array.prototype.some.call(key.classList, function (c) {
          return present[c];
        });
        key.parentNode.hidden = !drawn;
        if (drawn) shown += 1;
      });
      el.hidden = !on || !(shown || el.querySelector(".cg-legend-note"));
    }

    /* The diagram's legend, fitted to the elements about to be drawn. */
    function fitGraphLegends(els) {
      var present = {};
      els.forEach(function (el) {
        var d = el.data;
        if (d.source) {
          present[d.kind === "correlated" ? "cg-key-correlated"
                  : d.contracted ? "cg-key-leg" : "cg-key-causal"] = true;
        } else if (!d.isBox) {
          if (d.deterministic) present["cg-key-deterministic"] = true;
          if (d.kind) present["cg-key-" + d.kind] = true;
        }
      });
      fitLegend(modelLegend, true, present);
    }

    var cy = null;
    var pending = null;        // an offstage build not yet swapped in
    var queuedDraw = null;     // a draw asked for while that build was running
    var revealTimer = null;
    var settleTimer = null;

    /* What is shown: with the filter off, every variable; with it on, the
     * variables checked in it, none at first, in the selected context. The
     * picture is the summary for them (see summarize in causalweb_query.js).
     * With every variable shown, that is the model itself. `history` holds
     * the earlier states of the filter, for Undo. */
    var view = { filter: !!saved.shown, shown: saved.shown || {},
                 context: saved.cx, history: [], model: null, modelKey: null,
                 summary: null };

    /* Matrix state: the matrix on screen, and what the previous one showed. */
    var matrix = { current: null, last: null };

    /* Panning when the drag starts on a node.
     *
     * Cytoscape pans from the background only. Zoomed in far enough, a group
     * box covers the whole viewport and there is no background left to grab.
     * Nodes are ungrabbable, so Cytoscape does nothing with those drags and we
     * can pan on them ourselves without fighting it. Background drags and wheel
     * zoom stay native. `dragged` suppresses the click a drag ends with.
     */
    var lastHover = null;
    var panFrom = null;
    var fromNode = false;
    var dragged = false;
    var DRAG_SLOP = 4;      // px of movement before it counts as a drag

    function beginDrag(x, y) {
      panFrom = { x: x, y: y };
      dragged = false;
    }

    function moveDrag(x, y) {
      if (!panFrom || !fromNode || !cy) return;
      var dx = x - panFrom.x;
      var dy = y - panFrom.y;
      if (!dragged && Math.abs(dx) + Math.abs(dy) < DRAG_SLOP) return;
      dragged = true;
      canvas.classList.add("cg-panning");
      cy.panBy({ x: dx, y: dy });
      panFrom = { x: x, y: y };
    }

    function endDrag() {
      panFrom = null;
      canvas.classList.remove("cg-panning");
    }

    /* A button in the diagram's corner fits the graph to it again. It shows
     * only once the reader has panned or zoomed: a change of the viewport
     * while a pointer is pressed on the diagram, or just after a wheel turn
     * over it. A redraw fits the graph, and hides it again. */
    var fitBtn = control("button", { type: "button", class: "cg-fit",
                                     title: "Reset pan and zoom" }, "Reset view");
    fitBtn.hidden = true;
    canvasesWrap.appendChild(fitBtn);
    var pressing = false, lastWheel = 0, WHEEL_MS = 400;
    fitBtn.addEventListener("mousedown", function (evt) { evt.stopPropagation(); });
    fitBtn.addEventListener("click", function () {
      // the fit is the viewer's own move, however soon it follows the reader's
      pressing = false;
      lastWheel = 0;
      fitBtn.hidden = true;
      if (cy) clampZoom();
    });
    // A change of the viewport that the reader made, by a drag or the wheel.
    function byReader() { return pressing || Date.now() - lastWheel < WHEEL_MS; }

    canvasesWrap.addEventListener("mousedown", function (evt) {
      pressing = true;
      if (evt.button === 0) beginDrag(evt.clientX, evt.clientY);
    });
    window.addEventListener("mousemove", function (evt) {
      moveDrag(evt.clientX, evt.clientY);
    });
    window.addEventListener("mouseup", function () {
      pressing = false;
      endDrag();
    });
    // in the capture phase: Cytoscape keeps the wheel to itself
    canvasesWrap.addEventListener("wheel", function () { lastWheel = Date.now(); },
                                  { passive: true, capture: true });
    canvasesWrap.addEventListener("touchstart", function (evt) {
      pressing = true;
      if (evt.touches.length === 1) beginDrag(evt.touches[0].clientX, evt.touches[0].clientY);
    }, { passive: true });
    canvasesWrap.addEventListener("touchmove", function (evt) {
      if (evt.touches.length === 1) moveDrag(evt.touches[0].clientX, evt.touches[0].clientY);
    }, { passive: true });
    canvasesWrap.addEventListener("touchend", function () {
      pressing = false;
      endDrag();
    });

    /* Re-fit when the stage changes size.
     *
     * Cytoscape binds its own listener to the window, but nothing watches the
     * container, and the panel above the stage changes height on its own --
     * opening the filter adds lines to it. A graph fitted to the old height
     * is then left clipped at the bottom. */
    if (window.ResizeObserver) {
      var resizeTimer = null;
      new window.ResizeObserver(function () {
        if (resizeTimer) window.clearTimeout(resizeTimer);
        resizeTimer = window.setTimeout(function () {
          if (!cy || cy.destroyed()) return;
          cy.resize();
          clampZoom();
        }, 60);
      }).observe(canvasesWrap);
    }

    /* Clearing hover is bound to the DOM's mouseleave: Cytoscape's
     * "mouseout" also fires as the pointer crosses from one element to
     * another, which would wipe the cursor the instant mousemove set it.
     * Attached once here, since wire() runs again on every redraw. */
    canvasesWrap.addEventListener("mouseleave", function () {
      lastHover = null;
      canvas.classList.remove("cg-over-node");
      tip.hidden = true;
      if (cy) cy.elements().removeClass("hovered");
    });

    /* ---- the model, and what is shown of it ---- */

    /* A label that tells a variable apart from a namesake in another group.
     * Inside the diagram the enclosing box gives the context; in the filter
     * or the matrix there is none, so the group's name is added. */
    var labelCount = {};
    data.nodes.forEach(function (n) {
      labelCount[n.label] = (labelCount[n.label] || 0) + 1;
    });
    function labelOf(id) {
      var n = data.nodeById[id];
      if (!n) return id;
      if (labelCount[n.label] > 1 && n.group && data.groups[n.group]) {
        return n.label + " (" + data.groups[n.group].label + ")";
      }
      return n.label;
    }

    /* The graph as context `cx` sees it: the variables it holds at a single
     * value, and the edges that carry nothing under it. */
    function contextData(cx) {
      if (!cx) return data;
      var copy = {};
      Object.keys(data).forEach(function (k) { copy[k] = data[k]; });
      copy.fixed = cx.fixed || [];
      copy.inactiveEdges = cx.inactiveEdges || [];
      return copy;
    }

    // The context, which is part of the filter, and so applies only where
    // the filter does (see filtering).
    function currentContext() {
      return filtering() ? namedContext(view.context) : null;
    }

    function namedContext(name) {
      return (data.contexts || []).filter(function (c2) {
        return c2.name === name;
      })[0];
    }

    /* The model in the selected context, and the summary for the variables
     * shown, each worked out once and kept until what it depends on changes.
     * The summary keeps its elements by id, and the notes its tooltips have
     * needed (see noteFor). */
    function viewModel() {
      var cx = currentContext(), key = cx ? cx.name : "";
      if (!view.model || view.modelKey !== key) {
        view.model = window.CausalGraphQuery.build(contextData(cx));
        view.modelKey = key;
        view.summary = null;
      }
      return view.model;
    }

    /* The filter applies when every group is open, the "Every variable"
     * level. With any group closed, every variable is shown, at that level,
     * in no context. */
    function everyOpen() {
      return Object.keys(data.groups).every(function (g) { return open[g]; });
    }

    function filtering() { return view.filter && everyOpen(); }

    function shownList() {
      var all = data.nodes.map(function (n) { return n.id; });
      if (!filtering()) return all;
      return all.filter(function (id) { return view.shown[id]; });
    }

    function viewSummary() {
      var m = viewModel(), list = shownList(), key = list.join("\0");
      if (!view.summary || view.summary.key !== key) {
        var Q = window.CausalGraphQuery, value = Q.summarize(m, list), byId = {};
        Q.elements(value).forEach(function (e) { byId[e.id] = e; });
        view.summary = { key: key, value: value, byId: byId, notes: {} };
      }
      return view.summary.value;
    }

    function summaryElement(id) {
      viewSummary();
      return view.summary.byId[id];
    }

    /* Every change to what is shown goes through here: the filter's boxes
     * follow, and the picture is drawn again. */
    function changed(reveal) {
      syncFilter();
      draw(reveal);
    }

    /* Turn the filter on or off, or show a new set of variables, keeping the
     * state before for Undo. */
    function setFilter(on, shown, reveal) {
      view.history.push({ filter: view.filter, shown: view.shown });
      view.filter = on;
      view.shown = shown;
      changed(reveal);
    }

    function setShown(shown, reveal) { setFilter(true, shown, reveal); }

    /* Shortcuts into the filter: a pair from the matrix, and a variable
     * from the diagram. */
    function filterTo(ids, reveal) { setShown(keyed(ids), reveal); }

    filterBtn.addEventListener("click", function () {
      setFilter(!view.filter, view.shown);
      if (view.filter) search.focus();
    });

    boxesBox.addEventListener("change", function () { draw(); });

    undoBtn.addEventListener("click", function () {
      if (!view.history.length) return;
      var last = view.history.pop();
      view.filter = last.filter;
      view.shown = last.shown;
      changed();
    });

    /* The filter belongs to the "Every variable" level, the only one it
     * applies to. The filter's section shows while it is on, and
     * a note on the diagram while it shows nothing. */
    var emptyNote = control("div", { class: "cg-empty-note" },
      "Check variables in the filter to show them.");
    emptyNote.hidden = true;
    canvasesWrap.appendChild(emptyNote);

    function fitControls() {
      var on = everyOpen();
      filterBtn.hidden = !on;
      filterBtn.classList.toggle("cg-active", view.filter);
      filterBtn.setAttribute("aria-pressed", view.filter ? "true" : "false");
      undoBtn.disabled = !view.history.length;
      panel.hidden = !filtering();
      emptyNote.hidden = !filtering() || shownList().length > 0;
    }

    function say(parent, text, cls) {
      parent.appendChild(control("span", cls ? { class: cls } : {}, text));
    }

    /* The filter: the context, and a box for each variable, which is checked
     * when the variable is shown. The list is in causal order, the checked
     * variables first, and can be narrowed by a search.
     * "Reset" unchecks every variable and clears the search, and "Undo"
     * takes back the last change to the variables shown. */
    var filterBoxes = {};
    var filterRows = [], filterList = null;
    var search = control("input", { type: "search", class: "cg-filter-search",
                                    placeholder: "Search variables",
                                    "aria-label": "Search variables" });

    function buildFilter() {
      panel.textContent = "";
      if ((data.contexts || []).length) {
        var cxRow = control("div", { class: "cg-filter-row" });
        say(cxRow, "Context", "cg-filter-label");
        var cxSel = control("select", {});
        cxSel.appendChild(control("option", { value: "" }, "any (structure only)"));
        data.contexts.forEach(function (c2) {
          var opt = control("option", { value: c2.name }, c2.label || c2.name);
          if (c2.name === view.context) opt.setAttribute("selected", "selected");
          cxSel.appendChild(opt);
        });
        cxSel.addEventListener("change", function () {
          view.context = cxSel.value || null;
          changed();
        });
        cxRow.appendChild(cxSel);
        panel.appendChild(cxRow);
      }
      var row = control("div", { class: "cg-filter-row" });
      row.appendChild(search);
      var reset = control("button", { type: "button" }, "Reset");
      row.appendChild(reset);
      row.appendChild(undoBtn);
      panel.appendChild(row);
      var list = filterList = control("div", { class: "cg-filter-list" });
      // in the order of the matrix with every variable shown
      var causal = bucketOrder(data, data.nodes.map(function (n) { return n.id; }),
        data.edges.map(function (e) { return [e.source, e.target]; })).order;
      causal.forEach(function (id, rank) {
        var n = data.nodeById[id];
        var label = control("label", { class: "cg-filter-item" });
        var box = control("input", { type: "checkbox", "data-id": n.id });
        box.addEventListener("change", function () {
          var next = Object.assign({}, view.shown);
          if (box.checked) next[n.id] = true;
          else delete next[n.id];
          setShown(next);
        });
        label.appendChild(box);
        label.appendChild(document.createTextNode(labelOf(n.id)));
        list.appendChild(label);
        filterBoxes[n.id] = box;
        filterRows.push({ id: n.id, el: label, rank: rank,
                          text: (labelOf(n.id) + " " + n.id).toLowerCase() });
      });
      panel.appendChild(list);
      function narrow() {
        var words = search.value.toLowerCase().split(/\s+/).filter(Boolean);
        filterRows.forEach(function (r) {
          r.el.hidden = !words.every(function (w) { return r.text.indexOf(w) >= 0; });
        });
      }
      reset.addEventListener("click", function () {
        search.value = "";
        narrow();
        setShown({});
      });
      search.addEventListener("input", narrow);
      syncFilter();
    }

    /* The boxes follow what is shown, and the checked variables come first
     * in the list. Moving a row takes the focus from its box, so the focus
     * is put back. */
    function syncFilter() {
      Object.keys(filterBoxes).forEach(function (id) {
        filterBoxes[id].checked = !!view.shown[id];
      });
      if (!filterList) return;
      var focused = document.activeElement;
      filterRows.slice().sort(function (a, b) {
        return (view.shown[a.id] ? 0 : 1) - (view.shown[b.id] ? 0 : 1) || a.rank - b.rank;
      }).forEach(function (r, i) {
        if (filterList.children[i] !== r.el) filterList.insertBefore(r.el, filterList.children[i] || null);
      });
      if (focused && filterList.contains(focused) && document.activeElement !== focused) {
        focused.focus({ preventScroll: true });
      }
    }


    /* What the thing under the pointer is, for the tooltip. Edge explanations
     * have to be read somewhere other than the edge: with a dozen links among
     * five variables the labels rotate along the lines and collide. */
    function tipText(target) {
      if (!target || target === cy || !target.isNode) return "";
      // Nodes say nothing. An edge is highlighted, so its tooltip need not
      // name it. While a choice is open, it is what the reader looks at.
      if (target.isNode() || !chooser.hidden) return "";
      return partsText(target.data("parts") || []);
    }

    /* The tooltips of the summary's edges behind a drawn edge or a matrix
     * cell, each once, at most PARTS_SHOWN of them. */
    var PARTS_SHOWN = 3;

    function partsText(ids) {
      var texts = [];
      ids.forEach(function (id) {
        var el = summaryElement(id), text = el ? noteFor(el).text : "";
        if (text && texts.indexOf(text) < 0) texts.push(text);
      });
      // Legs between one pair are routes of one arrow, all of them taken.
      texts = texts.map(function (t, i) { return i ? "and " + t : t; });
      if (texts.length > PARTS_SHOWN) texts = texts.slice(0, PARTS_SHOWN).concat(["…"]);
      return texts.join("\n");
    }

    /* Placed against the stage, the positioned ancestor, to which
     * Cytoscape's rendered coordinates are already relative. Flipped below the pointer when there is no room above, and kept
     * inside the stage horizontally. */
    /* An absolutely positioned box with no set width shrinks to the room
     * left of it, so a tip placed near the right edge would wrap into a
     * column. It is measured at the left edge, where it has all the room,
     * and given that width before it is placed. */
    function sizeTip(el, text) {
      el.style.left = "0px";
      el.style.width = "auto";
      el.textContent = text;
      el.hidden = false;
      el.style.width = el.offsetWidth + "px";
      return { w: el.offsetWidth, h: el.offsetHeight };
    }

    function showTip(text, at) {
      if (!text || !at) { tip.hidden = true; return; }
      var size = sizeTip(tip, text);
      var room = canvasesWrap.getBoundingClientRect();
      var x = Math.min(Math.max(at.x + 14, 4), Math.max(4, room.width - size.w - 4));
      var y = at.y - size.h - 12;
      if (y < 4) y = at.y + 20;
      tip.style.left = Math.round(x) + "px";
      tip.style.top = Math.round(y) + "px";
    }

    /* What a leg or a <-> stands for, for its tooltip, and the variables a
     * click on it offers to reveal: at most CHOICES of those it names, the
     * first, the middle and the last. Worked out on first hover and kept.
     *
     * A leg gives its route (routeSteps in causalweb_query.js) in at most
     * ROUTE_NAMES names. Steps are joined by arrows. Names in parentheses
     * are alternatives: each route passes one of them. "…" stands for hidden
     * variables the text leaves out, however they are joined. A set of more
     * than SET_NAMES names the two that most routes pass. Past the limit,
     * sets give way to "…" first, the largest first, and then single names,
     * from the middle. A route with one step named and nothing else reads
     * "via X, Y, and Z". A <-> names the smallest set of variables its
     * shared causes act through, in the same form. */
    var CHOICES = 3, ROUTE_NAMES = 4, SET_NAMES = 3;

    /* "X", "X or Y", "X, Y, or Z"; "X, Y, …" when some are left out. Commas
     * would split a label that has one of its own, so then the names are
     * joined by the conjunction alone, or by spaces before a "…". */
    function listText(ids, more, conj) {
      var words = ids.map(labelOf);
      var commas = !words.some(function (w) { return w.indexOf(",") >= 0; });
      if (more) return words.concat(["\u2026"]).join(commas ? ", " : " ");
      if (words.length < 3 || !commas) return words.join(" " + conj + " ");
      return words.slice(0, -1).join(", ") + ", " + conj + " " + words[words.length - 1];
    }

    function trimmed(ids) {
      var shown = ids.length > SET_NAMES ? 2 : ids.length;
      return { names: ids.slice(0, shown), more: ids.length > shown };
    }

    function routeText(steps) {
      var items = steps.map(function (st) {
        if (st.gap) return { gap: true };
        var it = trimmed(st.names);
        it.set = !!st.set;
        return it;
      });
      function shown() { return items.filter(function (it) { return !it.gap; }); }
      function named() {
        return shown().reduce(function (n, it) { return n + it.names.length; }, 0);
      }
      items.filter(function (it) { return it.set; }).sort(function (x, y) {
        return y.names.length - x.names.length;
      }).forEach(function (it) { if (named() > ROUTE_NAMES) it.gap = true; });
      while (named() > ROUTE_NAMES) {
        var left = shown();
        left[Math.floor((left.length - 1) / 2)].gap = true;
      }
      // neighbouring gaps are one
      items = items.filter(function (it, i) { return !(it.gap && i && items[i - 1].gap); });
      var ids = [];
      shown().forEach(function (it) { ids = ids.concat(it.names); });
      var only = shown().length === 1 ? shown()[0] : null;
      var text = only ? listText(only.names, only.more, "and") : items.map(function (it) {
        if (it.gap) return "…";
        var list = listText(it.names, it.more, "or");
        return it.names.length + (it.more ? 1 : 0) > 1 ? "(" + list + ")" : list;
      }).join(" → ");
      return { text: "via " + text, ids: ids };
    }

    // the first, the middle and the last
    function spread(list) {
      if (list.length <= CHOICES) return list.slice();
      return [list[0], list[Math.floor((list.length - 1) / 2)], list[list.length - 1]];
    }

    function noteFor(el) {
      var m = viewModel(), s = viewSummary(), cache = view.summary.notes;
      if (el.id in cache) return cache[el.id];
      var Q = window.CausalGraphQuery, note = { text: "", choices: null };
      if (el.kind === "leg") {
        var r = routeText(Q.routeSteps(m, el));
        note.text = r.text;
        note.choices = spread(r.ids);
      } else if (el.kind === "bi" && !el.expandable) {
        note.text = "declared correlation";
      } else if (el.kind === "bi") {
        // a <-> that can be opened always has such a set (see causeCut)
        var causes = Q.causeSet(m, s.visible, el.source, el.target);
        if (causes && causes.length) {
          var it = trimmed(Q.inOrder(m, causes));
          note.text = "due to " + listText(it.names, it.more, "and");
          note.choices = it.names;
        }
        if (el.declared) {
          note.text = note.text ? note.text + "\nand a declared correlation" : "declared correlation";
        }
      }
      cache[el.id] = note;
      return note;
    }


    /* The variables a click on these legs or <-> edges offers to reveal (see
     * noteFor), at most CHOICES, or null when they offer none. */
    function revealChoices(els) {
      var out = [];
      els.forEach(function (el) {
        if (!el.expandable) return;
        (noteFor(el).choices || []).forEach(function (id) {
          if (out.indexOf(id) < 0) out.push(id);
        });
      });
      return out.length ? out.slice(0, CHOICES) : null;
    }

    function reveal(ids, origin) {
      var next = Object.assign({}, view.shown);
      ids.forEach(function (id) { next[id] = true; });
      setShown(next, { ids: keyed(ids), origin: origin });
    }

    /* A click on legs or <-> edges. One variable to reveal is revealed. With
     * more, a menu near the click at `place` ({ holder, x, y }, in the
     * holder's own coordinates) asks which. Every leg or <-> that can be
     * opened offers at least one (see noteFor). */
    function offerReveal(els, place, origin) {
      var ids = revealChoices(els);
      if (!ids) return;
      if (ids.length === 1) {
        reveal(ids, origin);
      } else {
        choose(ids, place, function (id) { reveal([id], origin); });
      }
    }

    /* The menu: one button for each variable. Any press outside it, Escape,
     * a pan or zoom, and any redraw close it. */
    var chooser = control("div", { class: "cg-choose" });
    chooser.hidden = true;
    chooser.addEventListener("mousedown", function (evt) { evt.stopPropagation(); });

    function closeChooser() {
      chooser.hidden = true;
      chooser.textContent = "";
    }

    function choose(ids, place, pick) {
      closeChooser();
      tip.hidden = true;
      if (chooser.parentNode !== place.holder) place.holder.appendChild(chooser);
      say(chooser, "Reveal", "cg-choose-head");
      ids.forEach(function (id) {
        var btn = control("button", { type: "button", "data-id": id }, labelOf(id));
        btn.addEventListener("click", function (evt) {
          evt.stopPropagation();
          closeChooser();
          pick(id);
        });
        chooser.appendChild(btn);
      });
      chooser.hidden = false;
      // kept inside the part of the holder on screen
      var h = place.holder, w = chooser.offsetWidth, ht = chooser.offsetHeight;
      var x = Math.min(place.x + 8, h.scrollLeft + h.clientWidth - w - 4);
      var y = place.y + 8;
      if (y + ht > h.scrollTop + h.clientHeight - 4) y = place.y - ht - 8;
      chooser.style.left = Math.round(Math.max(x, h.scrollLeft + 4)) + "px";
      chooser.style.top = Math.round(Math.max(y, h.scrollTop + 4)) + "px";
    }

    document.addEventListener("mousedown", function (evt) {
      if (!chooser.hidden && !chooser.contains(evt.target)) closeChooser();
    }, true);
    document.addEventListener("touchstart", function (evt) {
      if (!chooser.hidden && !chooser.contains(evt.target)) closeChooser();
    }, true);
    document.addEventListener("keydown", function (evt) {
      if (evt.key === "Escape") closeChooser();
    });

    // The summary's edges behind a drawn edge.
    function partsOf(edge) {
      return (edge.data("parts") || []).map(summaryElement).filter(Boolean);
    }

    // Handle for headless tests: a drawn edge's tooltip.
    container._edgesForTest = {
      tip: function (id) { return cy ? tipText(cy.getElementById(id)) : ""; },
    };

    function clampZoom() {
      cy.fit(undefined, 18);
      if (cy.zoom() < MIN_LEGIBLE_ZOOM) {
        cy.zoom(MIN_LEGIBLE_ZOOM);
        cy.center();
      }
    }

    /* Build the next graph offstage, then swap.
     *
     * Cytoscape paints elements the moment they are added, at default
     * positions, and ELK only reports real ones a beat later. Building into the
     * hidden canvas means that scramble is never on screen: the current graph
     * stays up untouched until the new one is laid out. reveal.ids marks nodes
     * that just appeared, highlighted briefly so a click's effect is obvious.
     */
    /* `queued` marks a draw deferred while a layout ran (see below). It
     * catches up with a state that was already current, so a menu opened
     * since stays open; a draw for a new state closes it. */
    function draw(reveal, queued) {
      // The pointer is about to be over something else, or over nothing.
      tip.hidden = true;
      if (!queued) closeChooser();
      lastHover = null;
      saveState();
      /* One build at a time.
       *
       * Two draws in the same turn -- a click that changes what is shown
       * while a layout is running does that -- would otherwise put two Cytoscape instances in the same
       * offstage container, each one's swap capturing the same predecessor and
       * trying to destroy it. Abandoning the first is no better: ELK lays out
       * asynchronously and hands its result back to an instance that is by
       * then destroyed. So a draw asked for mid-build is deferred to the swap,
       * where it picks up whatever the state has become. */
      if (pending) { queuedDraw = { reveal: reveal || null }; return; }
      fitControls();
      var els = buildElements(data, open, canNest() && boxesBox.checked, viewSummary(),
                              window.CausalGraphQuery.elements);
      fitGraphLegends(els);
      // Decided here, from the element list, so that the matrix can mark what
      // is new under the same rule the diagram tweens by.
      var tween = shouldMorph(els, reveal);
      renderMatrix(tween);
      var incoming = canvases[0] === canvas ? canvases[1] : canvases[0];
      var outgoing = canvas;
      var oldCy = cy;
      incoming.classList.add("cg-offstage");

      var next = window.cytoscape({
        container: incoming,
        elements: els,
        style: STYLE,
        minZoom: 0.12,
        maxZoom: 3,
        // Cytoscape's default wheel step (1) zooms a large graph past the
        // point of interest in two or three notches.
        wheelSensitivity: 0.33,
        // Dragging nodes is off: positions come from the layout and are
        // recomputed on every open/close, so a dragged node snaps back at the
        // next click.
        autoungrabify: true,
        boxSelectionEnabled: false,
        // Left enabled. Wheel zoom is zoom-about-the-cursor, which needs to pan
        // as it scales, so turning user panning off silently kills zooming too.
        // Cytoscape pans from the background; the handlers below add the case
        // it misses, dragging on a node.
        userPanningEnabled: true,
      });
      /* The shadow is laid out. Either tween the live graph into it, or,
       * when too little of what is on screen survives for a tween to read,
       * swap the canvases, as the first draw has to. */
      function arrive() {
        if (settleTimer) { window.clearTimeout(settleTimer); settleTimer = null; }
        if (cy === next || next.destroyed()) return;   // already arrived
        pending = null;
        if (tween) morph(next, reveal, finish);
        else swap();
      }
      function swap() {
        cy = next;
        canvas = incoming;
        container._cyForTest = cy;               // handle for headless UI tests
        clampZoom();
        incoming.classList.remove("cg-offstage");
        if (outgoing !== incoming) outgoing.classList.add("cg-offstage");
        if (oldCy) oldCy.destroy();
        wire();
        finish();
      }
      /* Shared tail: light what changed, and run a draw that was asked for
       * meanwhile. */
      function finish() {
        fitBtn.hidden = true;
        if (reveal && reveal.ids) {
          var inst = cy;
          var fresh = cy.nodes().filter(function (n) { return reveal.ids[n.id()]; });
          fresh.addClass("revealed");
          if (revealTimer) window.clearTimeout(revealTimer);
          revealTimer = window.setTimeout(function () {
            // a redraw in the meantime has taken this instance away
            if (!inst.destroyed()) fresh.removeClass("revealed");
          }, REVEAL_MS);
        }
        if (queuedDraw) {
          var again = queuedDraw;
          queuedDraw = null;
          draw(again.reveal, true);
        }
      }

      // The layout is run here, after layoutstop is bound, so the handler is
      // there before the layout can finish.
      var layout = next.layout(layoutOptions());
      pending = next;
      layout.one("layoutstop", arrive);
      // Safety net: never strand the new graph offstage if a layout dies quietly.
      if (settleTimer) window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(arrive, 6000);
      layout.run();
    }

    /* Can the live graph be tweened into the graph `els` describes? Only when
     * most of what is on screen stays; see MORPH_MAX_REMOVED. A caller that
     * knows the new picture is a different one says so with `swap`. */
    function shouldMorph(els, reveal) {
      if (reveal && reveal.swap) return false;
      if (!cy || cy.destroyed()) return false;
      var before = cy.nodes().length;
      if (!before) return false;
      var after = {};
      els.forEach(function (e) { if (!e.data.source) after[e.data.id] = true; });
      var removed = 0;
      cy.nodes().forEach(function (n) { if (!after[n.id()]) removed += 1; });
      return removed / before <= MORPH_MAX_REMOVED;
    }

    /* Tween the live graph into the laid-out shadow `next`, then drop the
     * shadow.
     *
     * Nodes that persist glide to their new places. New nodes start where
     * they came from -- the clicked edge for an opened leg, the nearest box
     * already on screen for a group's members -- and glide out from there.
     * The viewport follows to where the shadow's would be. The instance
     * stays the same throughout, so the handlers, the hover state and the
     * matrix's links to it all hold without being rebuilt. */
    function morph(next, reveal, done) {
      cy.stop();
      cy.nodes().stop();
      cy.edges().stop();
      cy.elements().removeClass("dimmed picked hovered revealed");
      var origin = reveal && reveal.origin;
      var liveBefore = {};
      cy.nodes().forEach(function (n) { liveBefore[n.id()] = true; });

      /* ELK's left-to-right choices are arbitrary, and one more node can make
       * it mirror the whole picture. Of the new layout and its mirror image,
       * take the one that moves what is already on screen the least. The
       * mirror is about the layout's own centre, so its extent, and with it
       * the viewport computed below, is unchanged. The comparison is on
       * positions relative to each side's mean, since the two layouts share
       * no origin. */
      var persisting = next.nodes().filter(function (n) {
        return !n.isParent() && liveBefore[n.id()];
      });
      var flip = false;
      if (persisting.length >= 2) {
        var meanLive = 0, meanNext = 0;
        persisting.forEach(function (n) {
          meanLive += cy.getElementById(n.id()).position().x;
          meanNext += n.position().x;
        });
        meanLive /= persisting.length;
        meanNext /= persisting.length;
        var same = 0, mirrored = 0;
        persisting.forEach(function (n) {
          var lx = cy.getElementById(n.id()).position().x - meanLive;
          var nx = n.position().x - meanNext;
          same += Math.abs(nx - lx);
          mirrored += Math.abs(-nx - lx);
        });
        flip = mirrored < same;
      }
      var bb = next.nodes().boundingBox({ includeLabels: false });
      var axis = (bb.x1 + bb.x2) / 2;

      var finalPos = {};
      next.nodes().forEach(function (n) {
        if (n.isParent()) return;            // a box is placed by its members
        var p = n.position();
        finalPos[n.id()] = { x: flip ? 2 * axis - p.x : p.x, y: p.y };
      });

      // Always a fresh object: Cytoscape keeps the object it is handed as the
      // node's position, so two nodes given the same one would move as one.
      function copyOf(p) { return { x: p.x, y: p.y }; }
      function startFor(n) {
        var id = n.id();
        if (origin && reveal.ids && reveal.ids[id]) return copyOf(origin);
        var parent = n.data("parent");
        while (parent) {
          if (liveBefore[parent]) return copyOf(cy.getElementById(parent).position());
          var up = next.getElementById(parent);
          parent = up.nonempty() ? up.data("parent") : null;
        }
        return copyOf(origin || finalPos[id] || n.position());
      }
      function copyData(ele) {
        var out = {}, d = ele.data();
        Object.keys(d).forEach(function (k) { out[k] = d[k]; });
        return out;
      }
      // An edge's route from ELK lives in these style bypasses on the shadow's
      // edge. A route is for the nodes' final places. A new edge starts with
      // every bend pulled onto the straight line between its two attachment
      // points and its bends ease out as the nodes glide. An edge that was
      // already there eases from the route it has to the one it gets: when
      // the two have different numbers of bends, the shorter is padded with
      // repeats of its last bend, which draws the same line, so that the two
      // can be interpolated bend for bend.
      var GEOMETRY = ["curve-style", "edge-distances", "source-endpoint",
                      "target-endpoint", "segment-weights", "segment-distances",
                      "segment-radii", "radius-type"];
      function geometryOf(edge) {
        var style = {};
        GEOMETRY.forEach(function (k) {
          var v = edge.style(k);
          if (v !== undefined && v !== null && v !== "") style[k] = v;
        });
        return style;
      }
      function routeOf(shadow) {
        var style = geometryOf(shadow);
        if (flip) mirrorGeometry(style);
        return style;
      }
      function segmentish(style) {
        var c = style["curve-style"];
        return (c === "segments" || c === "round-segments" || c === "straight") &&
               style["edge-distances"] === "endpoints";
      }
      /* The current geometry and the route as two styles with the same number
       * of bends, or null when the two are not both ELK routes. The start is
       * applied at once and the end's eased parts are animated towards. */
      function aligned(current, route) {
        if (!segmentish(current) || !segmentish(route)) return null;
        var cw = current["curve-style"] === "straight" ? [] : tokens(current["segment-weights"] || "");
        var cd = current["curve-style"] === "straight" ? [] : tokens(current["segment-distances"] || "");
        var rw = route["curve-style"] === "straight" ? [] : tokens(route["segment-weights"] || "");
        var rd = route["curve-style"] === "straight" ? [] : tokens(route["segment-distances"] || "");
        var n = Math.max(cw.length, rw.length);
        function pad(w, d, other) {
          // No bends: flat along the other route's bends. Fewer: the last bend
          // repeated, which adds segments of no length.
          if (!w.length) return [other.slice(), other.map(function () { return "0"; })];
          w = w.slice(); d = d.slice();
          while (w.length < n) { w.push(w[w.length - 1]); d.push(d[d.length - 1]); }
          return [w, d];
        }
        var c2 = pad(cw, cd, rw), r2 = pad(rw, rd, cw);
        var curve = n ? (route["curve-style"] === "straight" ? "round-segments" : route["curve-style"])
                      : "straight";
        var start = {
          "curve-style": curve, "edge-distances": "endpoints",
          "source-endpoint": withUnits(current["source-endpoint"], "px"),
          "target-endpoint": withUnits(current["target-endpoint"], "px"),
        };
        var end = {
          "source-endpoint": withUnits(route["source-endpoint"], "px"),
          "target-endpoint": withUnits(route["target-endpoint"], "px"),
        };
        if (n) {
          start["segment-weights"] = c2[0].join(" ");
          start["segment-distances"] = withUnits(c2[1].join(" "), "px");
          end["segment-weights"] = r2[0].join(" ");
          end["segment-distances"] = withUnits(r2[1].join(" "), "px");
          ["segment-radii", "radius-type"].forEach(function (k) {
            if (route[k]) start[k] = route[k];
          });
        }
        return { start: start, end: end };
      }
      // After an ease, Cytoscape reports the eased values comma-joined and
      // without units, a form its own parser then rejects when the next ease
      // tries to start from them. So values are written back space-separated
      // and in px before they are eased from.
      function withUnits(text, unit) {
        return tokens(text).map(function (t) {
          return /^-?\d*\.?\d+$/.test(t) ? t + unit : t;
        }).join(" ");
      }
      function flattened(route) {
        if (!route["segment-distances"]) return route;    // no bends: straight already
        var flat = {};
        Object.keys(route).forEach(function (k) { flat[k] = route[k]; });
        flat["segment-distances"] = tokens(route["segment-distances"])
          .map(function () { return "0"; }).join(" ");
        return flat;
      }
      // Cytoscape reports a multi-number style comma-joined and accepts it
      // either way, so both separators are read.
      function tokens(text) {
        return String(text).trim().split(/[\s,]+/).filter(function (t) { return t; });
      }
      // A route under a left-right mirror: the horizontal part of each
      // endpoint offset and the signed sideways distance of every bend
      // change sign; the weights along the edge do not.
      function negateFirst(text, all) {
        return tokens(text).map(function (tok, i) {
          if (!all && i > 0) return tok;
          var m = /^(-?\d*\.?\d+)(.*)$/.exec(tok);
          if (!m) return tok;
          var v = -parseFloat(m[1]);
          return (v === 0 ? "0" : String(v)) + m[2];
        }).join(" ");
      }
      function mirrorGeometry(style) {
        ["source-endpoint", "target-endpoint"].forEach(function (k) {
          if (style[k] && /px/.test(style[k])) style[k] = negateFirst(style[k], false);
        });
        if (style["segment-distances"]) {
          style["segment-distances"] = negateFirst(style["segment-distances"], true);
        }
      }
      // Bring a persisting element's data to the shadow's, dropping keys the
      // shadow does not have: a collapsed group's `collapsedGroup` has to go
      // for the box style to take over. `parent` is changed with move().
      function patchData(live, shadow) {
        var fresh = shadow.data(), old = live.data();
        Object.keys(old).forEach(function (k) {
          if (k !== "id" && k !== "parent" && k !== "source" && k !== "target" &&
              !(k in fresh)) live.removeData(k);
        });
        var patch = {};
        Object.keys(fresh).forEach(function (k) {
          if (k !== "id" && k !== "parent" && k !== "source" && k !== "target") {
            patch[k] = fresh[k];
          }
        });
        live.data(patch);
      }

      cy.startBatch();
      // 1. New nodes, boxes included, so every parent exists before any node
      //    is moved under it. A persisting node that gains children becomes a
      //    box on its own.
      var additions = [];
      next.nodes().forEach(function (n) {
        if (liveBefore[n.id()]) return;
        additions.push({ group: "nodes", data: copyData(n),
                         position: n.isParent() ? undefined : startFor(n) });
      });
      cy.add(additions);
      // 2. Persisting nodes: data, then parent.
      next.nodes().forEach(function (n) {
        if (!liveBefore[n.id()]) return;
        var live = cy.getElementById(n.id());
        patchData(live, n);
        var want = n.data("parent") || null;
        var have = live.data("parent") || null;
        if (want !== have) live.move({ parent: want });
      });
      // 3. Whatever the shadow does not have. Persisting members of a box
      //    that is going were moved out of it above, so they are not taken
      //    down with it.
      var gone = cy.elements().filter(function (e) {
        return next.getElementById(e.id()).empty();
      });
      gone.remove();
      // 4. Edges, once every endpoint is in place, each with its route.
      var liveEdgeBefore = {};
      cy.edges().forEach(function (e) { liveEdgeBefore[e.id()] = true; });
      var newEdges = [];
      next.edges().forEach(function (e) {
        var live = cy.getElementById(e.id());
        if (live.empty()) newEdges.push({ group: "edges", data: copyData(e) });
        else patchData(live, e);
      });
      cy.add(newEdges);
      var eases = [];                 // [edge, the route parts it eases towards]
      next.edges().forEach(function (e) {
        var live = cy.getElementById(e.id());
        if (live.empty()) return;
        var route = routeOf(e);
        if (!liveEdgeBefore[e.id()]) {
          live.style(flattened(route));
          if (route["segment-distances"]) {
            eases.push([live, { "segment-distances": route["segment-distances"] }, route]);
          }
          return;
        }
        var pair = aligned(geometryOf(live), route);
        if (pair) {
          live.style(pair.start);
          eases.push([live, pair.end, route]);
        } else {
          live.style(route);          // no ELK route before, so nothing to ease from
        }
      });
      cy.endBatch();
      // On the same clock as the nodes, so edges and nodes land together. At
      // the end each edge is given its route exactly, padding and all gone.
      function unfold() {
        eases.forEach(function (item) {
          var edge = item[0], route = item[2];
          edge.animate({ style: item[1] }, {
            duration: MORPH_MS, easing: "ease-in-out-cubic",
            complete: function () { if (route && !edge.removed()) edge.style(route); },
          });
        });
      }

      // Where the shadow's viewport ended up is where this one is going. The
      // two canvases are the same size, so the values carry over directly.
      next.fit(undefined, 18);
      if (next.zoom() < MIN_LEGIBLE_ZOOM) {
        next.zoom(MIN_LEGIBLE_ZOOM);
        next.center();
      }
      var zoom = next.zoom(), pan = next.pan();
      next.destroy();

      var inst = cy;
      var tween = cy.layout({
        name: "preset",
        positions: function (n) { return finalPos[n.id()]; },
        animate: true,
        animationDuration: MORPH_MS,
        animationEasing: "ease-in-out-cubic",
        fit: false,
      });
      tween.one("layoutstop", function () {
        if (!inst.destroyed()) done();
      });
      cy.animate({ zoom: zoom, pan: pan },
                 { duration: MORPH_MS, easing: "ease-in-out-cubic" });
      unfold();
      tween.run();
    }

    /* Where a leg's new variables start from: the middle of the leg. */
    function midpoint(edge) {
      var a = edge.source().position(), b = edge.target().position();
      return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    }

    /* The innermost open box whose frame is under this point, if any.
     *
     * Edges sit above compound parents in Cytoscape's hit testing, so an edge
     * crossing a box's border swallows clicks meant for the border. Closing a
     * group is a deliberate act and an edge has no click behaviour, so the
     * frame wins. */
    function boxFrameAt(pos) {
      var best = null, bestDepth = -1;
      cy.nodes("[isBox = 1]").forEach(function (box) {
        if (!onBoxFrame(box, pos)) return;
        var depth = box.ancestors().length;
        if (depth > bestDepth) { best = box; bestDepth = depth; }
      });
      return best;
    }

    function closeBox(box) {
      var name = groupName(box.id());
      closeGroup(data, name, open);
      draw({ ids: keyed(G(name)) });
    }

    /* What a click at this point would do.
     *
     * The cursor is derived from this too, so the pointer can never promise
     * something a click won't deliver. Anything that changes click behaviour
     * has to change here, and the cursor follows automatically.
     */
    function actionAt(target, pos) {
      var isNode = target && target !== cy && target.isNode && target.isNode();
      var isEdge = target && target !== cy && target.isEdge && target.isEdge();
      // An edge that stands for something hidden opens up.
      if (isEdge && target.data("expandable")) {
        return { kind: "expandEdge", edge: target };
      }
      // An open box's frame wins over whatever is drawn across it: closing is
      // deliberate, and edges have no click behaviour to lose.
      var box = boxFrameAt(pos);
      if (box) return { kind: "close", box: box };
      if (isNode) {
        if (target.data("isBox")) return { kind: "pan" };   // box interior
        if (target.data("collapsedGroup") && onOpenAffordance(target, pos)) {
          return { kind: "open", node: target };
        }
        return { kind: "highlight", node: target };
      }
      if (isEdge) return { kind: "pan" };
      return { kind: "clear" };
    }

    var CLICKABLE = { close: 1, open: 1, highlight: 1, expandEdge: 1 };

    function wire() {
      // Cytoscape handles background drags itself; we only take over when the
      // press landed on a node, where it does nothing.
      cy.on("tapstart", function (evt) { fromNode = evt.target !== cy; });
      // The menu stays by what was clicked, so the reader's pan or zoom
      // closes it. The fit after a redraw does not.
      cy.on("viewport", function () {
        if (!byReader()) return;
        closeChooser();
        fitBtn.hidden = false;
      });

      // One tap handler for everything, driven by actionAt, so behaviour and
      // cursor cannot drift apart.
      cy.on("tap", function (evt) {
        if (dragged) return;      // this tap ends a pan
        var act = actionAt(evt.target, evt.position);

        if (act.kind === "expandEdge") {
          offerReveal(partsOf(act.edge), { holder: canvasesWrap, x: evt.renderedPosition.x,
                                           y: evt.renderedPosition.y }, midpoint(act.edge));
          return;
        }

        if (act.kind === "close") { closeBox(act.box); return; }

        if (act.kind === "open") {
          var name = groupName(act.node.id());
          openThrough(data, name, open);
          // Light the group itself: it is the thing that changed, and it is
          // where the eye already is.
          draw({ ids: keyed(G(name)) });
          return;
        }

        if (act.kind === "clear" || (act.kind === "highlight" &&
                                     act.node.hasClass("picked"))) {
          // Background, or the already-highlighted node again: clear.
          clearHighlight();
          return;
        }

        if (act.kind !== "highlight") return;
        // At the level the filter applies to, a click on a variable filters
        // to it alone.
        if (everyOpen() && !act.node.data("collapsedGroup")) {
          filterTo([act.node.id()], { ids: keyed(act.node.id()) });
          return;
        }
        highlightNode(act.node);
      });

      /* Cursor and hover, from the same decision as the click.
       *
       * Hover highlighting only appears where a click would highlight, so the
       * badge and a box frame stay quiet -- they do something else. Edges still
       * light up on hover (that is what makes the thicket traceable) but only
       * where they are not lying across a frame.
       */
      cy.on("mousemove", function (evt) {
        var act = actionAt(evt.target, evt.position);
        canvas.classList.toggle("cg-over-node", !!CLICKABLE[act.kind]);

        var target = null;
        if (act.kind === "highlight") target = act.node;
        else if (act.kind === "expandEdge") target = act.edge;
        else if (act.kind === "pan" && evt.target !== cy &&
                 evt.target.isEdge && evt.target.isEdge()) target = evt.target;

        // Repositioned on every move so the tooltip tracks the pointer; the
        // classes below only change when the element under it does.
        showTip(tipText(evt.target), evt.renderedPosition);

        var key = target ? target.id() : null;
        if (key === lastHover) return;      // avoid restyling on every pixel
        lastHover = key;
        cy.elements().removeClass("hovered");
        if (!target) { mxClear(); return; }
        target.addClass("hovered");
        if (target.isNode()) {
          target.connectedEdges().addClass("hovered");
          mxMark(target.id(), null);
        } else {
          mxMark(target.data("source"), target.data("target"));
        }
        target.connectedNodes().addClass("hovered");
      });

    }

    /* ---- highlighting a node, from the diagram or the matrix ---- */

    function clearHighlight() {
      if (!cy) return;
      cy.elements().removeClass("dimmed");
      cy.nodes().removeClass("picked");
      mxPicked(null);
    }

    function highlightNode(node) {
      // its causes and its effects, all the way up and down
      var keep = node.union(node.predecessors().union(node.successors()));
      // keep ancestor boxes of anything retained, or members float loose
      keep = keep.union(keep.ancestors());
      cy.elements().addClass("dimmed");
      keep.removeClass("dimmed");
      cy.nodes().removeClass("picked");
      node.addClass("picked");
      mxPicked(node.id());
    }

    function toggleHighlight(node) {
      if (node.hasClass("picked")) clearHighlight();
      else highlightNode(node);
    }

    /* ---- adjacency matrix ---- */

    /* Beside the graph, the same buckets as rows and columns. A cell is a
     * direct edge, a path through hidden variables, both (hatched), a causal
     * path through the variables shown, or none, and has a dashed outline
     * when the two are correlated. Rows and columns are in causal order, so
     * the matrix is upper-triangular and a cell below the diagonal means two
     * collapsed groups depend on each other. The top-level groups show as
     * blocks along both axes. */
    var mxTable = null;

    function cellKey(s, t) { return s + "\0" + t; }

    function cssQuote(value) {
      return '"' + String(value).replace(/["\\]/g, "\\$&") + '"';
    }

    /* The matrix of the summary on screen. Each cell keeps the summary's
     * edges behind it: `direct` and `legs` for the arrows from row to column,
     * `correlated` for the <-> between the two, both ways round. */
    function computeMatrix() {
      var s = viewSummary(), members = {}, bucketOf = {};
      s.visible.forEach(function (v) {
        var b = bucketFor(data, v, open);
        (members[b] = members[b] || []).push(v);
        bucketOf[v] = b;
      });
      var direct = {}, legs = {}, correlated = {}, edgeKeys = [], links = [];
      function add(map, k, e) { (map[k] = map[k] || []).push(e); }
      s.solid.concat(s.legs).forEach(function (e) {
        var a = bucketOf[e.source], b = bucketOf[e.target];
        if (!a || !b || a === b) return;
        var k = cellKey(a, b);
        if (!direct[k] && !legs[k]) edgeKeys.push([a, b]);
        add(e.kind === "leg" ? legs : direct, k, e);
      });
      s.bidirected.forEach(function (e) {
        var a = bucketOf[e.source], b = bucketOf[e.target];
        if (!a || !b || a === b) return;
        add(correlated, cellKey(a, b), e);
        add(correlated, cellKey(b, a), e);
        links.push([a, b]);
      });
      /* Paths and indirect correlations between the buckets as drawn, so a
       * shared cause inside one collapsed group does not count: the diagram
       * cannot show it. */
      var buckets = Object.keys(members), reach = {}, far = {};
      var dep = window.CausalGraphQuery.dependence(buckets, edgeKeys, links);
      buckets.forEach(function (a) {
        Object.keys(dep.reach[a]).forEach(function (b) { reach[cellKey(a, b)] = true; });
        Object.keys(dep.apart[a]).forEach(function (b) { far[cellKey(a, b)] = true; });
      });
      var ordered = bucketOrder(data, buckets, edgeKeys);
      var labels = {};
      buckets.forEach(function (b) {
        labels[b] = isGroupId(b) ? data.groups[groupName(b)].label : labelOf(b);
      });
      return { order: ordered.order, cyclic: ordered.cyclic, labels: labels,
               members: members, direct: direct, legs: legs, reach: reach,
               correlated: correlated, far: far };
    }

    // The summary's edges a click on a cell opens: its legs, or else its <->.
    function cellParts(mx, k) {
      function open(list) { return (list || []).filter(function (e) { return e.expandable; }); }
      var legs = open(mx.legs[k]);
      return legs.length ? legs : open(mx.correlated[k]);
    }

    /* `continuous` says the diagram tweens into this state, so what is new in the matrix is worth pointing out:
     * rows and columns that appeared fade in with their headers lit, and
     * cells among the rows that stayed, whose state changed, are outlined. */
    function renderMatrix(continuous) {
      if (mxTable) { mxScroll.removeChild(mxTable); mxTable = null; }
      tip.hidden = true;
      matrix.current = null;
      container._matrixForTest = null;
      var mx = computeMatrix();
      // The legend keys of the cells drawn.
      var present = {};
      matrix.current = mx;
      var was = matrix.last;         // what the matrix showed before this one
      var fresh = {}, cells = {}, kept = 0;
      mx.order.forEach(function (b) {
        if (!(continuous && was)) return;
        if (was.rows[b]) kept += 1;
        else fresh[b] = true;
      });
      // With nothing kept there is nothing to mark the new against.
      if (!kept) fresh = {};
      function cellState(k) {
        var arrow = mx.direct[k] && mx.legs[k] ? "both" : mx.direct[k] ? "direct"
                  : mx.legs[k] ? "leg" : mx.reach[k] ? "reach" : "";
        return arrow + (mx.correlated[k] ? "+corr" : mx.far[k] ? "+far" : "");
      }
      var n = mx.order.length;
      function colourOf(b) {
        return PALETTE[(data.rootIndex[rootOf(data, b)] || 0) % PALETTE.length];
      }
      // The line between two top-level groups is drawn by the last cell of
      // the block before it, as its right or bottom border.
      function endsBlock(i) {
        return i < n - 1 && rootOf(data, mx.order[i]) !== rootOf(data, mx.order[i + 1]);
      }

      var table = control("table", { class: "cg-mx" });
      var thead = control("thead"), hrow = control("tr");
      var corner = control("th", { class: "cg-mx-corner" });
      corner.appendChild(control("span", {}, "cause ↓   effect →"));
      hrow.appendChild(corner);
      mx.order.forEach(function (b, j) {
        var th = control("th", { class: "cg-mx-col", "data-b": b });
        th.appendChild(control("span", {}, mx.labels[b]));
        th.style.setProperty("--strip", colourOf(b));
        if (fresh[b]) th.classList.add("cg-mx-new");
        if (endsBlock(j)) th.classList.add("cg-mx-break");
        hrow.appendChild(th);
      });
      thead.appendChild(hrow);
      table.appendChild(thead);

      var tbody = control("tbody");
      mx.order.forEach(function (s, i) {
        var tr = control("tr");
        if (endsBlock(i)) tr.classList.add("cg-mx-rbreak");
        var th = control("th", { class: "cg-mx-row", "data-b": s }, mx.labels[s]);
        th.style.setProperty("--strip", colourOf(s));
        if (fresh[s]) th.classList.add("cg-mx-new");
        tr.appendChild(th);
        mx.order.forEach(function (t, j) {
          var td = control("td", { class: "cg-mx-cell", "data-s": s, "data-t": t });
          if (endsBlock(j)) td.classList.add("cg-mx-break");
          var k = cellKey(s, t);
          var state = cellState(k);
          cells[k] = state;
          if (fresh[s] || fresh[t]) td.classList.add("cg-mx-new");
          else if (continuous && was && k in was.cells && was.cells[k] !== state) {
            td.classList.add("cg-mx-changed");
          }
          if (s === t) {
            td.classList.add("cg-mx-diag");
          } else if (mx.direct[k] && mx.legs[k]) {
            td.classList.add("cg-mx-both");
            // the hatching is read from the keys of its two colours
            present["cg-key-mx-both"] = present["cg-key-mx-direct"] = present["cg-key-mx-leg"] = true;
          } else if (mx.direct[k]) {
            td.classList.add("cg-mx-direct");
            present["cg-key-mx-direct"] = true;
          } else if (mx.legs[k]) {
            td.classList.add("cg-mx-leg");
            present["cg-key-mx-leg"] = true;
          } else if (mx.reach[k]) {
            td.classList.add("cg-mx-reach");
            present["cg-key-mx-reach"] = true;
          }
          if (mx.correlated[k]) {
            td.classList.add("cg-mx-corr");
            present["cg-key-mx-corr"] = true;
          } else if (s !== t && mx.far[k]) {
            td.classList.add("cg-mx-far");
            present["cg-key-mx-far"] = true;
          }
          // a cell that stands for something hidden opens up; at the level
          // the filter applies to, any other one filters to its pair
          if (s !== t && (cellParts(mx, k).length || everyOpen() && !isGroupId(s) &&
                          !isGroupId(t))) td.classList.add("cg-mx-clickable");
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      mxScroll.appendChild(table);
      mxTable = table;
      fitLegend(matrixLegend, true, present);
      fitCells();
      var rows = {};
      mx.order.forEach(function (b) { rows[b] = true; });
      matrix.last = { rows: rows, cells: cells };
      // The marks are a moment's cue, like the diagram's, and fade.
      if (matrix.revealTimer) window.clearTimeout(matrix.revealTimer);
      matrix.revealTimer = window.setTimeout(function () {
        if (mxTable !== table) return;
        mxEach(".cg-mx-new, .cg-mx-changed", function (el) {
          el.classList.remove("cg-mx-new");
          el.classList.remove("cg-mx-changed");
        });
      }, MORPH_MS + REVEAL_MS);
      container._matrixForTest = mx;           // handle for headless UI tests
    }

    /* The cells are as large as MX_CELL_MAX, or smaller where the table
     * would not fit the pane otherwise, down to MX_CELL_MIN, past which the
     * pane scrolls. The headers are measured at a size where their text is
     * already full size. The pane's own size, scroll bars included, is what
     * counts, so a scroll bar coming or going does not change the fit. */
    var MX_CELL_MIN = 11, MX_CELL_MAX = 32;

    function fitCells() {
      var n = matrix.current ? matrix.current.order.length : 0;
      if (!mxTable || !n) return;
      mxPane.style.setProperty("--mx-cell", "12px");
      var corner = mxTable.querySelector("th.cg-mx-corner");
      // less the table's margins; each cell also draws one grid line
      var w = mxScroll.offsetWidth - corner.offsetWidth - 14;
      var h = mxScroll.offsetHeight - corner.offsetHeight - 14;
      var cell = Math.floor(Math.min(w, h) / n) - 1;
      cell = Math.max(MX_CELL_MIN, Math.min(MX_CELL_MAX, cell));
      mxPane.style.setProperty("--mx-cell", cell + "px");
    }

    if (window.ResizeObserver) {
      var fitTimer = null;
      new window.ResizeObserver(function () {
        if (fitTimer) window.clearTimeout(fitTimer);
        fitTimer = window.setTimeout(fitCells, 60);
      }).observe(mxScroll);
    }

    function mxEach(selector, fn) {
      if (!mxTable) return;
      Array.prototype.forEach.call(mxTable.querySelectorAll(selector), fn);
    }

    function mxClear() {
      mxEach(".cg-mx-hl", function (el) { el.classList.remove("cg-mx-hl"); });
    }

    /* Light the headers of what the pointer is on: of a cell or an edge,
     * the cause's row and the effect's column, and the cell; of a bucket
     * alone, its row and its column. */
    function mxMark(s, t) {
      mxClear();
      if (!mxTable) return;
      function light(selector) {
        mxEach(selector, function (el) { el.classList.add("cg-mx-hl"); });
      }
      if (!t) {
        if (s) light("th[data-b=" + cssQuote(s) + "]");
        return;
      }
      light("th.cg-mx-row[data-b=" + cssQuote(s) + "]");
      light("th.cg-mx-col[data-b=" + cssQuote(t) + "]");
      if (s !== t) {
        var td = mxTable.querySelector(
          "td[data-s=" + cssQuote(s) + "][data-t=" + cssQuote(t) + "]");
        if (td) td.classList.add("cg-mx-hl");
      }
    }

    /* A picked node keeps its row and column lit while the rest fade. */
    function mxPicked(id) {
      if (!mxTable) return;
      mxEach(".cg-mx-picked, .cg-mx-inline", function (el) {
        el.classList.remove("cg-mx-picked");
        el.classList.remove("cg-mx-inline");
      });
      mxTable.classList.toggle("cg-mx-focus", !!id);
      if (!id) return;
      mxEach("th[data-b=" + cssQuote(id) + "]", function (el) {
        el.classList.add("cg-mx-picked");
      });
      mxEach("td[data-s=" + cssQuote(id) + "], td[data-t=" + cssQuote(id) + "]",
        function (el) { el.classList.add("cg-mx-inline"); });
    }

    /* Hover from the matrix, shown on the diagram. */
    function cyHover(ids, edgeIds) {
      if (!cy || cy.destroyed()) return;
      cy.elements().removeClass("hovered");
      ids.forEach(function (id) {
        if (id) cy.getElementById(id).addClass("hovered");
      });
      (edgeIds || []).forEach(function (id) {
        cy.getElementById(id).addClass("hovered");
      });
    }

    /* A cell's tooltip names the pair, "X to Y", the row first, and then
     * says what the cell marks, one line for the causal effect of X on Y and
     * one for the correlation of the two. Each is "Direct" for an arrow or
     * a <-> on the diagram, "Indirect" for one through the variables shown,
     * or "No". What an arrow or a <-> stands for is in the diagram's
     * tooltip. */
    function mxTipText(s, t, mx) {
      if (s === t || !chooser.hidden) return "";
      var k = cellKey(s, t);
      return [
        mx.labels[s] + " to " + mx.labels[t],
        mx.direct[k] || mx.legs[k] ? "Direct causal effect"
          : mx.reach[k] ? "Indirect causal effect" : "No causal effect",
        mx.correlated[k] ? "Direct correlation"
          : mx.far[k] ? "Indirect correlation" : "No correlation",
      ].join("\n");
    }

    /* Positioned against the stage, like the diagram's. */
    function showMxTip(text, evt) {
      if (!text) { tip.hidden = true; return; }
      var size = sizeTip(tip, text);
      var room = stage.getBoundingClientRect();
      var px = evt.clientX - room.left, py = evt.clientY - room.top;
      var x = Math.min(px + 14, room.width - size.w - 4);
      var y = py - size.h - 12;
      if (y < 4) y = py + 20;
      tip.style.left = Math.round(Math.max(x, 4)) + "px";
      tip.style.top = Math.round(y) + "px";
    }

    function mxTarget(evt) {
      var el = evt.target;
      if (!el || !el.closest) return {};
      return { td: el.closest("td[data-s]"), th: el.closest("th[data-b]") };
    }

    mxPane.addEventListener("mousemove", function (evt) {
      var mx = matrix.current;
      if (!mx || !mxTable) return;
      var hit = mxTarget(evt);
      if (hit.td) {
        var s = hit.td.getAttribute("data-s"), t = hit.td.getAttribute("data-t");
        mxMark(s, t);
        var edges = s === t ? [] : ["e", "l", "c"].map(function (p) {
          return p + s + ">" + t;
        }).concat(["c" + t + ">" + s]);
        cyHover([s, t], edges);
        showMxTip(mxTipText(s, t, mx), evt);
      } else if (hit.th) {
        var b = hit.th.getAttribute("data-b");
        mxMark(b, null);
        cyHover([b], []);
        var what = isGroupId(b) ? " (" + mx.members[b].length + " variables)" : "";
        showMxTip(mx.labels[b] + what, evt);
      } else {
        mxClear();
        cyHover([], []);
        tip.hidden = true;
      }
    });
    mxPane.addEventListener("mouseleave", function () {
      mxClear();
      cyHover([], []);
      tip.hidden = true;
    });
    /* A cell that stands for something hidden opens up, as its edge on the
     * diagram does. Any other cell between two variables, at the level the
     * filter applies to, is a question about them: the filter goes to the
     * pair. A header is the node, so clicking it highlights the node. */
    mxPane.addEventListener("click", function (evt) {
      var hit = mxTarget(evt), mx = matrix.current;
      if (hit.td && mx) {
        var s = hit.td.getAttribute("data-s"), t = hit.td.getAttribute("data-t");
        if (s === t) return;
        var els = cellParts(mx, cellKey(s, t));
        if (!els.length) {
          if (everyOpen() && !isGroupId(s) && !isGroupId(t)) filterTo([s, t], { ids: keyed([s, t]) });
          return;
        }
        // An edge between the two on the diagram, for the new variables to
        // start from.
        var edge = cy ? cy.edges().filter(function (e) {
          var a1 = e.data("source"), b1 = e.data("target");
          return a1 === s && b1 === t || a1 === t && b1 === s;
        }) : null;
        var origin = edge && edge.nonempty() ? midpoint(edge[0]) : null;
        var room = mxScroll.getBoundingClientRect();
        offerReveal(els, {
          holder: mxScroll,
          x: evt.clientX - room.left + mxScroll.scrollLeft,
          y: evt.clientY - room.top + mxScroll.scrollTop,
        }, origin);
      } else if (hit.th && cy) {
        var node = cy.getElementById(hit.th.getAttribute("data-b"));
        if (node.length) toggleHighlight(node);
      }
    });
    /* ---- view state in the fragment (whole-window page only) ---- */

    function saveState() {
      if (!document.body.classList.contains("cg-standalone")) return;
      var hash = viewHash(data, open, view.filter && view.shown, view.context, boxesBox.checked);
      if (window.location.hash !== hash && window.history &&
          window.history.replaceState) {
        window.history.replaceState(null, "", hash);
      }
    }

    newTab.addEventListener("click", function () {
      var url = standaloneUrl(container,
        viewHash(data, open, view.filter && view.shown, view.context, boxesBox.checked));
      if (url) window.open(url, "_blank");
    });

    buildFilter();
    draw();
  }

  ready(function () {
    var containers = document.querySelectorAll(".causal-graph");
    if (!containers.length) return;
    var sources;
    try {
      sources = JSON.parse(containers[0].getAttribute("data-scripts") || "[]");
    } catch (err) {
      return;
    }
    if (typeof window.cytoscape !== "undefined") {
      Array.prototype.forEach.call(containers, init);
      return;
    }
    loadAll(sources, function (ok) {
      if (!ok) return; // nothing to show without Cytoscape
      Array.prototype.forEach.call(containers, init);
    });
  });
})();
