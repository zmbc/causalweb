/* Interactive causal graph viewer.
 *
 * Progressive enhancement: each .causal-graph container ships with a static
 * placeholder. We only build the widget once Cytoscape has actually loaded,
 * so a CDN failure leaves a readable diagram rather than an empty box.
 *
 * Hierarchy is shown by containment: an open group is a labelled box holding its
 * members. Containment is used rather than colour because colour only separates
 * a handful of categories, and this model has twenty groups. Colour is therefore
 * reserved for the top-level group alone.
 */
(function () {
  "use strict";

  var PALETTE = ["#4C72B0", "#DD8452", "#55A868", "#C44E52", "#8172B3", "#937860"];

  // Below roughly this zoom, labels stop being readable and nodes get too small
  // to click. We pan rather than shrink past it.
  var MIN_LEGIBLE_ZOOM = 0.5;
  var REVEAL_MS = 650;       // how long the group you just acted on stays lit
  // A redraw tweens the graph on screen into its new layout over this long.
  // The edges unfold from straight lines into their routes over the same time.
  var MORPH_MS = 350;
  // Above this share of on-screen nodes disappearing, the new picture is a
  // different one, and a tween into it reads as noise: the canvases are
  // swapped instead. Nodes appearing do not count, since they start from
  // the place they came from and the motion reads as an unfold.
  var MORPH_MAX_REMOVED = 0.5;
  // How close to a box's edge, or how far down from its top, a click counts as
  // hitting the box's frame rather than its empty interior.
  var BOX_EDGE = 14;
  var BOX_TITLE = 26;
  // Tolerance so the border line itself is aimable from either side.
  var BORDER_SLACK = 4;
  // Size of the "open" badge drawn in a closed group's top-right corner, and
  // of the square that counts as hitting it.
  var BADGE = 12;
  var OPEN_HIT = 17;

  /* The badge is a real drawn control rather than a "+" glued onto the label:
   * a label-borne one moves when the text wraps, so the hit box stops matching
   * what is on screen. */
  var PLUS_BADGE = "data:image/svg+xml;utf8," + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16">' +
    '<circle cx="8" cy="8" r="7" fill="#ffffff" stroke="#5a6470" stroke-width="1.2"/>' +
    '<path d="M8 4.3v7.4M4.3 8h7.4" stroke="#33393f" stroke-width="1.7" ' +
    'stroke-linecap="round"/></svg>'
  );

  /* Group names and variable names are separate namespaces in the YAML, but share
   * one id space in Cytoscape -- and compound layout needs a group and its members
   * present at the same time. (This model has a `postpartum_depression` group AND
   * variable.) So group ids are prefixed on the way in. */
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

  /* Open exactly one level.
   *
   * This used to cascade through groups whose only content was a single child
   * group, because in the old flat rendering such a level looked like a no-op:
   * one dashed box swapped for another. With boxes that reasoning is gone --
   * the level is visible as containment -- and cascading instead produced two
   * nested frames from one click, which is both surprising and redundant. */
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
   * every scope, not just the top level, is what stops nested boxes colliding
   * too. The order comes from the graph rather than being hard-coded, so it
   * stays right as the model changes; a scope whose sibling graph has a cycle
   * is left unpartitioned rather than ordered arbitrarily.
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
      var keys = siblings[parent];
      var succ = {}, indeg = {};
      keys.forEach(function (k) { succ[k] = {}; indeg[k] = 0; });
      data.edges.forEach(function (e) {
        var a = owner[parent + "|" + e.source];
        var b = owner[parent + "|" + e.target];
        if (!a || !b || a === b || succ[a][b]) return;
        succ[a][b] = true;
        indeg[b] += 1;
      });
      var declared = {};
      keys.forEach(function (k, i) { declared[k] = i; });
      function byDeclaration(a, b) { return declared[a] - declared[b]; }
      var queue = keys.filter(function (k) { return !indeg[k]; });
      var order = {}, rank = 0, seen = 0;
      while (queue.length) {
        queue.sort(byDeclaration);
        var k = queue.shift();
        order[k] = rank++;
        seen += 1;
        Object.keys(succ[k]).forEach(function (m) {
          if (--indeg[m] === 0) queue.push(m);
        });
      }
      orders[parent] = seen === keys.length ? order : null;
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

  /* Descendants of every variable, computed once per graph. */
  function descendantsOf(data) {
    if (data.descendants) return data.descendants;
    var children = {};
    data.nodes.forEach(function (n) { children[n.id] = []; });
    data.edges.forEach(function (e) {
      if (children[e.source]) children[e.source].push(e.target);
    });
    var out = {};
    function walk(v) {
      if (out[v]) return out[v];
      var seen = {};
      out[v] = seen;                       // acyclic, so never read back
      (children[v] || []).forEach(function (c) {
        seen[c] = true;
        Object.keys(walk(c)).forEach(function (d) { seen[d] = true; });
      });
      return seen;
    }
    data.nodes.forEach(function (n) { walk(n.id); });
    data.descendants = out;
    return out;
  }

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

    var indeg = {}, succ = {};
    buckets.forEach(function (b) { indeg[b] = 0; succ[b] = []; });
    edgeKeys.forEach(function (e) { succ[e[0]].push(e[1]); indeg[e[1]] += 1; });
    function byPos(a, b) { return pos[a] - pos[b]; }
    var ready = buckets.filter(function (b) { return !indeg[b]; });
    var out = [], done = {};
    while (ready.length) {
      ready.sort(byPos);
      var b = ready.shift();
      out.push(b);
      done[b] = true;
      succ[b].forEach(function (t) { if (--indeg[t] === 0) ready.push(t); });
    }
    var left = hier.filter(function (b) { return !done[b]; });
    return { order: out.concat(left), cyclic: left.length > 0 };
  }

  /* The adjacency matrix of the graph as currently bucketed.
   *
   * `direct` maps "s\0t" to the variable-level edges behind that cell, `reach`
   * marks bucket pairs joined by any directed path, and `correlated` the
   * pairs declared correlated, both ways round. */
  function computeMatrix(data, open, labeller) {
    var members = {}, bucketOf = {};
    data.nodes.forEach(function (n) {
      var b = bucketFor(data, n.id, open);
      (members[b] = members[b] || []).push(n.id);
      bucketOf[n.id] = b;
    });
    var direct = {}, edgeKeys = [];
    data.edges.forEach(function (e) {
      var s = bucketOf[e.source], t = bucketOf[e.target];
      if (!s || !t || s === t) return;
      var k = s + "\0" + t;
      if (!direct[k]) { direct[k] = []; edgeKeys.push([s, t]); }
      direct[k].push([e.source, e.target]);
    });
    var desc = descendantsOf(data), reach = {};
    data.nodes.forEach(function (n) {
      Object.keys(desc[n.id] || {}).forEach(function (d) {
        var s = bucketOf[n.id], t = bucketOf[d];
        if (s && t && s !== t) reach[s + "\0" + t] = true;
      });
    });
    var correlated = {};
    (data.correlated || []).forEach(function (pair) {
      var s = bucketOf[pair[0]], t = bucketOf[pair[1]];
      if (!s || !t || s === t) return;
      correlated[s + "\0" + t] = true;
      correlated[t + "\0" + s] = true;
    });
    var buckets = Object.keys(members);
    var ordered = bucketOrder(data, buckets, edgeKeys);
    var labels = {};
    buckets.forEach(function (b) {
      labels[b] = isGroupId(b) ? data.groups[groupName(b)].label : labeller(b);
    });
    return { order: ordered.order, cyclic: ordered.cyclic, labels: labels,
             members: members, direct: direct, reach: reach,
             correlated: correlated };
  }

  /* `nested` draws open groups as compound boxes. It requires a layout that
   * understands compound nodes: without one, boxes have no computed size and
   * pile up on top of each other, which is far worse than showing no boxes at
   * all. So when ELK is unavailable we build the same graph flat. */
  function buildElements(data, open, nested) {
    var els = [], seen = {}, needBox = {};
    var orders = nested ? scopeOrders(data) : null;
    // Rank of `key` among its siblings in `parent`'s scope.
    function partitionFor(parent, key) {
      if (!orders) return undefined;
      var scope = orders[parent || ""];
      return scope && key in scope ? scope[key] : undefined;
    }

    data.nodes.forEach(function (n) {
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

    var edgeSeen = {};
    data.edges.forEach(function (e) {
      var s = bucketFor(data, e.source, open);
      var t = bucketFor(data, e.target, open);
      if (s === t) return;
      var key = s + ">" + t;
      if (edgeSeen[key]) return;
      edgeSeen[key] = true;
      els.push({ data: { id: "e" + key, source: s, target: t, kind: "causal" } });
    });

    (data.correlated || []).forEach(function (pair) {
      var s = bucketFor(data, pair[0], open);
      var t = bucketFor(data, pair[1], open);
      if (s === t || !seen[s] || !seen[t]) return;
      els.push({
        data: { id: "c" + s + ">" + t, source: s, target: t, kind: "correlated" },
      });
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
        // can stay centred instead of being nudged aside.
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
    // In the answer view, a leg that stands for routes through hidden
    // variables is dotted; an edge the model has as such is solid.
    {
      selector: "edge[contracted = 1]",
      style: { "line-style": "dotted" },
    },
    /* Edges carry their explanation in `note`, read out on hover rather than
     * drawn: with a dozen edges among five nodes, labels rotate along the
     * lines, collide with each other and are simply illegible. */
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
      },
    },
    { selector: "node.hovered", style: { "border-color": "#1f6feb", "border-width": 2.5 } },
    // The group just opened or closed, briefly, so the change is easy to find.
    {
      selector: "node.revealed",
      style: { "background-color": "#fff6d8", "border-color": "#d9a300",
               "border-width": 2.5 },
    },
    // A box is mostly transparent, so tint the frame rather than the fill.
    {
      selector: "node[isBox = 1].revealed",
      style: { "border-color": "#d9a300", "border-width": 2.5,
               "background-color": "#d9a300", "background-opacity": 0.13 },
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
      // Generous enough that sibling boxes keep a visible gap rather than
      // ending up flush against each other, which reads as an overlap.
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

  /* Did a click land on a box's frame -- its border or its title strip --
   * rather than the empty space inside it? */
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

  /* ELK itself is never animated: it runs offstage, on a shadow copy of the
   * graph, and the live graph is then tweened into the finished result (see
   * morph), so the continuity comes from the tween rather than from the
   * layout algorithm. */
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
   * and named in data-standalone. Earlier this page was assembled in the
   * browser and opened as a blob URL, which does not survive: a blob belongs to
   * the document that created it, so reloading the tab, bookmarking it, or
   * letting sphinx-autobuild refresh the page behind it all leave nothing to
   * load. The open groups ride along in the fragment so the bigger view starts
   * where the reader left off. */
  function standaloneUrl(container, open) {
    var name = container.getAttribute("data-standalone");
    if (!name) return null;
    var groups = Object.keys(open || {}).filter(function (g) { return open[g]; });
    return scriptBase() + name + "#open=" +
           groups.map(encodeURIComponent).join(",");
  }

  function hashParam(name) {
    var re = new RegExp("(?:^|[#&])" + name + "=([^&]*)");
    var match = re.exec(window.location.hash || "");
    return match ? match[1] : null;
  }

  /* The view state carried in the fragment: open groups, the query pair, the
   * legs opened on its answer, its context, and whether the matrix is shown. "New tab" hands the open
   * groups over this way, and the whole-window page keeps all of it current,
   * so a reload -- the live-reloading server does one on every edit -- comes
   * back to the same view. Section anchors cannot collide with any of this:
   * they carry no "=". */
  function stateFromHash(data) {
    var state = { open: null, q: null, x: [], cx: null, mx: false };
    var open = hashParam("open");
    if (open !== null) {
      state.open = {};
      open.split(",").forEach(function (part) {
        var name = decodeURIComponent(part);
        if (name && data.groups[name]) state.open[name] = true;
      });
    }
    var q = hashParam("q");
    if (q !== null) {
      var pair = q.split(",").map(decodeURIComponent);
      if (pair.length === 2 && data.nodeById[pair[0]] && data.nodeById[pair[1]]) {
        state.q = pair;
      }
    }
    var x = hashParam("x");
    state.x = x === null ? [] : x.split(",").map(decodeURIComponent).filter(function (id) {
      return !!data.nodeById[id];
    });
    var cx = hashParam("cx");
    if (cx !== null) {
      cx = decodeURIComponent(cx);
      if ((data.contexts || []).some(function (c2) { return c2.name === cx; })) {
        state.cx = cx;
      }
    }
    state.mx = hashParam("mx") === "1";
    return state;
  }

  function requestFullscreen(el) {
    var fn = el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen;
    if (fn) fn.call(el);
  }

  function exitFullscreen() {
    var fn = document.exitFullscreen || document.webkitExitFullscreen ||
             document.msExitFullscreen;
    if (fn) fn.call(document);
  }

  function fullscreenElement() {
    return document.fullscreenElement || document.webkitFullscreenElement ||
           document.msFullscreenElement || null;
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

    /* controls: presets are buttons, not a dropdown -- opening groups one at a
     * time reaches states matching no preset, and a dropdown would keep showing
     * a stale selection. */
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

    var queryBtn = control("button",
      { type: "button", title: "Check whether the relationship between two variables is confounded" },
      "Query");
    var reset = control("button", { type: "button" }, "Reset view");
    var full = control("button", { type: "button", title: "Fullscreen" }, "Fullscreen");
    var newTab = control("button", { type: "button", title: "Open in a new tab" }, "New tab");
    var mxBtn = control("button",
      { type: "button", title: "Show the adjacency matrix beside the graph" },
      "Matrix");
    [presetBar, queryBtn, mxBtn, reset, full, newTab]
      .forEach(function (el) { bar.appendChild(el); });
    // nothing to open from the whole-window page: it is already that page
    if (!container.getAttribute("data-standalone")) newTab.hidden = true;

    var panel = control("div", { class: "causal-graph-panel", hidden: "hidden" });

    // Two stacked canvases: the next graph is built and laid out in the hidden
    // one, then swapped in. Rebuilding in place blanks the view for as long as
    // the layout takes, which reads as a flicker on every click.
    var stage = control("div", { class: "causal-graph-stage" });
    // The graph's own column: its canvases, with its legend under them. The
    // matrix pane is a column of the same shape beside it when it is on, so
    // each side's legend sits under its own picture.
    var graphCol = control("div", { class: "cg-graph" });
    var canvasesWrap = control("div", { class: "cg-canvases" });
    var canvases = [
      control("div", { class: "causal-graph-canvas" }),
      control("div", { class: "causal-graph-canvas cg-offstage" }),
    ];
    canvases.forEach(function (el) { canvasesWrap.appendChild(el); });
    // Lives above both canvases and survives the swap between them.
    var tip = control("div", { class: "cg-tip" });
    tip.hidden = true;
    canvasesWrap.appendChild(tip);
    graphCol.appendChild(canvasesWrap);
    stage.appendChild(graphCol);
    var mxPane = control("div", { class: "cg-matrix" });
    mxPane.hidden = true;
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

    /* The query view's legend REPLACES the model one rather than being
     * restated in the panel as prose: the two views share no keys, so showing
     * both at once would be showing one that does not apply. */
    var modelLegend = container.querySelector(".causal-graph-legend");
    if (modelLegend) graphCol.appendChild(modelLegend);
    var queryLegend = control("div", { class: "causal-graph-legend" });
    [["cg-key-query", "query variables"],
     ["cg-key-shared", "confounder"],
     ["cg-key-via", "other variables"],
     ["cg-key-causal", "causes directly"],
     ["cg-key-leg", "causes through hidden variables"],
     ["cg-key-correlated", "correlated"]].forEach(function (k) {
      var span = control("span", {});
      span.appendChild(control("i", { class: "cg-key " + k[0] }));
      span.appendChild(document.createTextNode(k[1]));
      queryLegend.appendChild(span);
    });
    queryLegend.hidden = true;
    graphCol.appendChild(queryLegend);

    /* The matrix's keys sit in the matrix pane, under the table. */
    var matrixLegend = control("div", { class: "causal-graph-legend cg-matrix-legend" });
    [["cg-key-mx-direct", "direct edge (a number counts the variable-level edges)"],
     ["cg-key-mx-reach", "causal path, no direct edge"],
     ["cg-key-mx-corr", "correlated"]].forEach(function (k) {
      var span = control("span", {});
      span.appendChild(control("i", { class: "cg-key " + k[0] }));
      span.appendChild(document.createTextNode(k[1]));
      matrixLegend.appendChild(span);
    });
    matrixLegend.appendChild(control("span", { class: "cg-legend-note" },
      "matrix: rows cause columns, in causal order"));
    matrixLegend.hidden = true;
    mxPane.appendChild(matrixLegend);

    /* In the answer view the matrix is of the projection, so its cells mean
     * something else and get a legend of their own. */
    var matrixAnswerLegend = control("div", { class: "causal-graph-legend cg-matrix-legend" });
    [["cg-key-mx-direct", "direct edge"],
     ["cg-key-mx-leg", "path through hidden variables (a number counts its independent routes)"],
     ["cg-key-mx-reach", "reaches through the variables shown"],
     ["cg-key-mx-corr", "shared upstream causes or a correlation"]].forEach(function (k) {
      var span = control("span", {});
      span.appendChild(control("i", { class: "cg-key " + k[0] }));
      span.appendChild(document.createTextNode(k[1]));
      matrixAnswerLegend.appendChild(span);
    });
    matrixAnswerLegend.appendChild(control("span", { class: "cg-legend-note" },
      "matrix of the answer: rows cause columns; click a leg to open it"));
    matrixAnswerLegend.hidden = true;
    mxPane.appendChild(matrixAnswerLegend);

    function showLegendFor(answerView) {
      queryLegend.hidden = !answerView;
      if (modelLegend) modelLegend.hidden = !!answerView;
    }

    var cy = null;
    var pending = null;        // an offstage build not yet swapped in
    var queuedDraw = null;     // a draw asked for while that build was running
    var revealTimer = null;
    var settleTimer = null;

    /* Causal-query state.
     *
     * `answer` holds the result of the last query; `showing` means the canvas
     * is displaying the latent projection of that answer rather than the model
     * itself. Queries always run on the full variable-level graph, whatever is
     * currently open on screen. */
    var query = { on: false, a: null, b: null, answer: null, showing: false,
                  // variables revealed by expanding projected edges
                  extra: {},
                  // selected context, or null for "any"
                  context: null };

    /* Matrix state: whether the pane is shown, and the last computed matrix. */
    var matrix = { on: false, current: null };

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

    canvasesWrap.addEventListener("mousedown", function (evt) {
      if (evt.button === 0) beginDrag(evt.clientX, evt.clientY);
    });
    window.addEventListener("mousemove", function (evt) {
      moveDrag(evt.clientX, evt.clientY);
    });
    window.addEventListener("mouseup", endDrag);
    canvasesWrap.addEventListener("touchstart", function (evt) {
      if (evt.touches.length === 1) beginDrag(evt.touches[0].clientX, evt.touches[0].clientY);
    }, { passive: true });
    canvasesWrap.addEventListener("touchmove", function (evt) {
      if (evt.touches.length === 1) moveDrag(evt.touches[0].clientX, evt.touches[0].clientY);
    }, { passive: true });
    canvasesWrap.addEventListener("touchend", endDrag);

    /* Re-fit when the stage changes size.
     *
     * Cytoscape binds its own listener to the window, but nothing watches the
     * container, and the panel above the stage changes height on its own --
     * entering the answer view adds lines to it. A graph fitted to the old
     * height is then left clipped at the bottom. */
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

    /* Clearing hover is bound to the DOM, not to Cytoscape: cy's "mouseout"
     * also fires as the pointer crosses from one element to another, which
     * wiped the cursor the instant mousemove had set it. Attached once here,
     * not in wire(), which re-runs on every redraw. */
    canvasesWrap.addEventListener("mouseleave", function () {
      lastHover = null;
      canvas.classList.remove("cg-over-node");
      tip.hidden = true;
      if (cy) cy.elements().removeClass("hovered");
    });

    /* ---- causal queries ---- */

    /* A label that tells a variable apart from a namesake in another group.
     * Inside the diagram the enclosing box gives the context; in a dropdown,
     * the panel or the matrix there is none, so the group's name is added. */
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

    /* The graph as the selected context sees it: the variables it holds at a
     * single value, and the edges that carry nothing under it. */
    function contextData() {
      var cx = currentContext();
      if (!cx) return data;
      var copy = {};
      Object.keys(data).forEach(function (k) { copy[k] = data[k]; });
      copy.fixed = cx.fixed || [];
      copy.inactiveEdges = cx.inactiveEdges || [];
      return copy;
    }

    function currentContext() {
      return (data.contexts || []).filter(function (c2) {
        return c2.name === query.context;
      })[0];
    }

    function runQuery() {
      if (!window.CausalGraphQuery || !query.a || !query.b) return;
      query.answer = window.CausalGraphQuery.analyze(
        contextData(), query.a, query.b);
    }

    /* Every change to the query has to go through here.
     *
     * The canvas is a function of the query state -- in the answer view it is
     * built from the answer itself -- so changing that state without redrawing
     * leaves the old graph on screen with the new state's behaviour attached to
     * it: marks land on nodes that are no longer there, clicks resolve against
     * a view that has moved on. */
    function queryChanged(reveal) {
      // Panel first: it sits above the stage, so its height decides how much
      // room the graph has, and the layout that follows fits into that.
      renderPanel();
      draw(reveal);
    }

    /* Name one of the pair, from the pickers or from a click on the diagram.
     *
     * Anything revealed by opening a leg belonged to the previous answer, so it
     * goes. The answer is shown as soon as there is one: naming both variables
     * is the whole question, so there is nothing further to ask for. */
    function setEndpoints(first, second) {
      query.a = first;
      query.b = second;
      query.answer = null;
      query.extra = {};
      runQuery();
      query.showing = !!query.answer;
      queryChanged();
    }

    function resetQuery() {
      query.a = query.b = query.answer = null;
      query.showing = false;
      query.extra = {};
    }

    function say(parent, text, cls) {
      parent.appendChild(control("span", cls ? { class: cls } : {}, text));
    }

    /* Mark the endpoints on the model view. The answer view already colours
     * them by role, so it is left alone. Called after every swap, because a
     * redraw builds a new Cytoscape instance and drops the classes. */
    function markPicked() {
      if (!cy || !query.on || query.showing) return;
      cy.nodes().removeClass("picked");
      [query.a, query.b].forEach(function (id) {
        if (id) cy.getElementById(id).addClass("picked");
      });
    }

    /* A dropdown of every variable. Clicking nodes works too, but the fully
     * expanded graph is far taller than the viewport, so hunting for an
     * endpoint by eye means panning around; picking by name is the usable
     * path and clicking is the shortcut. */
    function variablePicker(selected, onChange, allowed) {
      var sel = control("select", {});
      sel.appendChild(control("option", { value: "" }, "—"));
      data.nodes.slice().sort(function (a, b) {
        var la = labelOf(a.id), lb = labelOf(b.id);
        return la < lb ? -1 : la > lb ? 1 : 0;
      }).forEach(function (n) {
        // A stale selection stays listed, so the panel can explain it rather
        // than the dropdown silently showing something else.
        if (allowed && !allowed[n.id] && n.id !== selected) return;
        var opt = control("option", { value: n.id }, labelOf(n.id));
        if (n.id === selected) opt.setAttribute("selected", "selected");
        sel.appendChild(opt);
      });
      sel.addEventListener("change", function () { onChange(sel.value || null); });
      return sel;
    }


    function renderPanel() {
      panel.textContent = "";
      if (!query.on) { panel.hidden = true; return; }
      panel.hidden = false;

      if ((data.contexts || []).length) {
        var cxRow = control("div", { class: "cg-panel-pick" });
        say(cxRow, "Context", "cg-pick-label");
        var cxSel = control("select", {});
        cxSel.appendChild(control("option", { value: "" }, "any (structure only)"));
        data.contexts.forEach(function (c2) {
          var opt = control("option", { value: c2.name }, c2.label || c2.name);
          if (c2.name === query.context) opt.setAttribute("selected", "selected");
          cxSel.appendChild(opt);
        });
        cxSel.addEventListener("change", function () {
          query.context = cxSel.value || null;
          setEndpoints(query.a, query.b);
        });
        cxRow.appendChild(cxSel);
        panel.appendChild(cxRow);
      }

      var picker = control("div", { class: "cg-panel-pick" });
      say(picker, "Variables", "cg-pick-label");
      picker.appendChild(variablePicker(query.a, function (id) {
        setEndpoints(id, query.b);
      }));
      say(picker, "and", "cg-pick-label");
      picker.appendChild(variablePicker(query.b, function (id) {
        setEndpoints(query.a, id);
      }));
      panel.appendChild(picker);

      if (!query.a || !query.b) {
        say(panel, "Pick two variables above, or click two in the diagram.",
          "cg-hint");
        return;
      }

      var a = query.answer;
      var head = control("div", { class: "cg-panel-head" });
      say(head, labelOf(query.a) + "  and  " + labelOf(query.b), "cg-panel-pair");
      panel.appendChild(head);

      var body = control("div", { class: "cg-panel-body" });

      if (a.fromIsConstant || a.toIsConstant) {
        var frozen = [];
        if (a.fromIsConstant) frozen.push(labelOf(a.from));
        if (a.toIsConstant) frozen.push(labelOf(a.to));
        say(body, frozen.join(" and ") + " "
          + (frozen.length > 1 ? "are" : "is") + " held at a single value in"
          + " this context, so there is no variation to relate to anything"
          + " else.", "cg-fact cg-bad");
        panel.appendChild(body);
        panel.appendChild(queryActions(a));
        return;
      }

      /* Which one causes the other is a fact to report, not something the
       * reader had to know to ask the question. The graph is acyclic, so it
       * can only be one of them or neither. */
      say(body, a.causes
        ? labelOf(a.causes[0]) + " causes " + labelOf(a.causes[1]) + "."
        : "Neither causes the other.", "cg-fact");

      /* Not "confounded": that word is about an influence being measured, and
       * a query here is a pair, with no influence required. What is true
       * either way is that something upstream moves both. The diagram says
       * which -- restating it as a list of names was the same answer twice. */
      say(body, a.confounded
        ? (a.causes ? "They are also correlated through common causes."
                    : "They are correlated through common causes.")
        : "They share no common causes.",
        a.confounded ? "cg-fact" : "cg-fact cg-good");
      panel.appendChild(body);
      panel.appendChild(queryActions(a));
    }

    /* What the thing under the pointer is, for the tooltip. Edge explanations
     * have to be read somewhere other than the edge: with a dozen links among
     * five variables the labels rotate along the lines and collide. */
    function tipText(target) {
      if (!query.showing || !target || target === cy || !target.isNode) return "";
      // Nodes say nothing: their colour is their role, and the legend has it.
      if (target.isNode()) return "";
      var note = target.data("note");
      var arrow = target.data("kind") === "correlated" ? " ↔ " : " → ";
      var lead = labelOf(target.data("source")) + arrow
               + labelOf(target.data("target"));
      if (!note) return lead;
      return lead + " — " + note
        + (target.data("expandable") ? " (click to open)" : "");
    }

    /* Placed against the stage, not the page: the stage is the positioned
     * ancestor, and Cytoscape's rendered coordinates are already relative to
     * it. Flipped below the pointer when there is no room above, and kept
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

    /* No "show me the answer" step: naming two variables IS the question, so
     * the answer replaces the diagram straight away. What is worth a button is
     * getting back -- to the answer as first drawn, and to the model. */
    function queryActions(a) {
      var actions = control("div", { class: "cg-panel-actions" });
      if (Object.keys(query.extra).length) {
        var back = control("button", { type: "button" }, "Collapse again");
        back.addEventListener("click", function () {
          query.extra = {};
          queryChanged();
        });
        actions.appendChild(back);
      }
      var clearBtn = control("button", { type: "button" }, "New query");
      clearBtn.addEventListener("click", function () {
        resetQuery();
        // Back to the model: a different picture, not a rearrangement.
        queryChanged({ swap: true });
      });
      actions.appendChild(clearBtn);
      return actions;
    }

    /* The kept set: the endpoints, the variables they share upstream, and
     * anything revealed by opening a leg. */
    function answerKeep() {
      var a = query.answer;
      var keep = a.keep.concat(Object.keys(query.extra)).filter(
        function (v, i, arr) { return arr.indexOf(v) === i; });
      /* Restored on every read, not just when the query is first run: opening
       * a leg grows the kept set, and a bigger kept set can expose a shared
       * cause that was previously hidden behind one of its own descendants. */
      return window.CausalGraphQuery.closeUnexplained(a.model, a.from, a.to, keep);
    }

    function answerProjection() {
      var Q = window.CausalGraphQuery;
      return Q.project(query.answer.model, answerKeep());
    }

    /* What each shown variable is to the others, read off the projection
     * rather than off how it came to be shown. A query endpoint; a
     * confounder, which causes both query variables, directly or through
     * other variables shown; or any other variable on the paths. */
    var ROLE_COLOUR = { query: "#1f6feb", confounder: "#b06f00", via: "#6c757d" };

    function answerRoles(keep, pr) {
      var succ = {};
      keep.forEach(function (id) { succ[id] = []; });
      pr.directed.forEach(function (e) { (succ[e[0]] = succ[e[0]] || []).push(e[1]); });
      function reaches(from, to) {
        var seen = {}, stack = (succ[from] || []).slice();
        while (stack.length) {
          var n = stack.pop();
          if (n === to) return true;
          if (seen[n]) continue;
          seen[n] = true;
          (succ[n] || []).forEach(function (c) { stack.push(c); });
        }
        return false;
      }
      var roles = {};
      keep.forEach(function (id) {
        roles[id] = (id === query.a || id === query.b) ? "query"
                  : reaches(id, query.a) && reaches(id, query.b) ? "confounder" : "via";
      });
      return roles;
    }



    /* Why, as a graph: the two endpoints, the variables they share upstream,
     * and a leg for each contracted run between them. Each leg says how many
     * independent routes it stands for and opens at its narrowest waist. */
    function projectionElements() {
      var a = query.answer;
      var keep = answerKeep();
      var pr = answerProjection();
      var els = [];
      var roles = answerRoles(keep, pr);
      keep.forEach(function (id) {
        /* The pair share a colour because the question does not distinguish
         * them. Everything else is coloured by what it is in the picture as
         * drawn: a fork, or a variable on a route. */
        /* No `deterministic` or `kind`, deliberately: those thicken or fill
         * some variables, which in this view is a distinction with no key in
         * the legend -- it made one of the two query variables look
         * emphasised over the other. Here colour carries the only difference
         * that matters. */
        els.push({ data: {
          id: id,
          label: labelOf(id),
          colour: ROLE_COLOUR[roles[id]],
          role: roles[id],
        }});
      });
      var Q = window.CausalGraphQuery;
      pr.directed.forEach(function (e) {
        var ex = Q.explainEdge(a.model, pr, keep, e[0], e[1], "causal");
        var routes = ex.routes || 0;
        var contracted = (ex.through || []).length > 0;
        els.push({ data: {
          id: "p" + e[0] + ">" + e[1], source: e[0], target: e[1],
          kind: "causal", expandable: ex.add.length ? 1 : 0,
          // An edge the model has as such, or a leg standing for routes
          // through variables not shown. The two are coloured apart.
          contracted: contracted ? 1 : 0,
          note: routes > 1 ? routes + " independent routes"
              : contracted ? "one route" : "a direct edge",
        }});
      });
      pr.bidirected.forEach(function (e) {
        var ex = Q.explainEdge(a.model, pr, keep, e[0], e[1], "correlated");
        els.push({ data: {
          id: "q" + e[0] + ">" + e[1], source: e[0], target: e[1],
          kind: "correlated", expandable: ex.add.length ? 1 : 0,
          note: ex.irreducible
            ? "correlated by construction"
            : ex.latentOnly
              ? "via a correlation"
              : "shared upstream: " + ex.via.map(labelOf).join(", "),
        }});
      });
      return els;
    }

    /* Reveal what a projected edge stands for: the next variable along a
     * contracted chain, or the nearest common cause behind a `<->`. */
    function expandAnswerLeg(source, target, kind) {
      var Q = window.CausalGraphQuery;
      var keep = answerKeep();
      var ex = Q.explainEdge(query.answer.model, answerProjection(), keep,
                             source, target, kind);
      if (!ex.add.length) return null;
      ex.add.forEach(function (id) { query.extra[id] = true; });
      return ex.add;
    }

    function expandAnswerEdge(edge) {
      return expandAnswerLeg(edge.data("source"), edge.data("target"),
                             edge.data("kind"));
    }

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
    function draw(reveal) {
      // The pointer is about to be over something else, or over nothing.
      tip.hidden = true;
      lastHover = null;
      showLegendFor(query.showing && query.answer);
      saveState();
      /* One build at a time.
       *
       * Two draws in the same turn -- changing both endpoints at once does
       * that -- would otherwise put two Cytoscape instances in the same
       * offstage container, each one's swap capturing the same predecessor and
       * trying to destroy it. Abandoning the first is no better: ELK lays out
       * asynchronously and hands its result back to an instance that is by
       * then destroyed. So a draw asked for mid-build is deferred to the swap,
       * where it picks up whatever the state has become. */
      if (pending) { queuedDraw = { reveal: reveal || null }; return; }
      var showingAnswer = query.showing && query.answer;
      var els = showingAnswer ? projectionElements()
                              : buildElements(data, open, canNest());
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
      /* Shared tail: light what changed, restore the query marks, and run a
       * draw that was asked for meanwhile. */
      function finish() {
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
        markPicked();
        if (queuedDraw) {
          var again = queuedDraw;
          queuedDraw = null;
          draw(again.reveal);
        }
      }

      // The layout is run explicitly rather than passed to the constructor, so
      // that layoutstop is bound before the layout can finish.
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
          live.style(route);          // not an ELK route before: nothing to ease from
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
      /* Picking by click belongs to the model view, where it is a shortcut for
       * the dropdowns. Once the answer is up there is nothing on screen that
       * is not already part of it, and a click that threw the answer away to
       * start over was startling rather than useful -- so a variable there is
       * something to hover, not something to press. */
      if (query.on && isNode && !target.data("isBox") &&
          !target.data("collapsedGroup")) {
        return { kind: query.showing ? "inspect" : "pick", node: target };
      }
      // In the answer view an edge is a summary of something, so it opens up.
      if (query.showing && isEdge && target.data("expandable")) {
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

    var CLICKABLE = { close: 1, open: 1, highlight: 1, pick: 1, expandEdge: 1 };
    container._actionAtForTest = actionAt;   // handle for headless UI tests

    function wire() {
      // Cytoscape handles background drags itself; we only take over when the
      // press landed on a node, where it does nothing.
      cy.on("tapstart", function (evt) { fromNode = evt.target !== cy; });

      // One tap handler for everything, driven by actionAt, so behaviour and
      // cursor cannot drift apart.
      cy.on("tap", function (evt) {
        if (dragged) return;      // this tap is the end of a pan, not a click
        var act = actionAt(evt.target, evt.position);

        if (act.kind === "inspect") return;      // hoverable, not pressable

        if (act.kind === "pick") {
          var id = act.node.id();
          // A half-finished pair completes; anything else starts over, which
          // includes clicking a variable while its answer is on screen.
          if (query.a && !query.b) setEndpoints(query.a, id);
          else setEndpoints(id, null);
          return;
        }

        if (act.kind === "expandEdge") {
          var origin = midpoint(act.edge);
          var added = expandAnswerEdge(act.edge);
          if (added) queryChanged({ ids: keyed(added), origin: origin });
          return;
        }

        if (act.kind === "close") { closeBox(act.box); return; }

        if (act.kind === "open") {
          var name = groupName(act.node.id());
          openThrough(data, name, open);
          // Light the group itself, not its members: it is the thing that
          // changed, and it is where the eye already is.
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
        else if (act.kind === "pick" || act.kind === "inspect") target = act.node;
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
      // Both directions, always: the one-sided options were a control to
      // read and choose between for a filter that is a glance either way.
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
     * direct edge, shaded by how many variable-level edges stand behind it, a
     * causal path with no direct edge, or a correlated pair. Rows and columns
     * are in causal order, so the matrix is upper-triangular and a cell below
     * the diagonal means two collapsed groups depend on each other. The
     * top-level groups show as blocks along both axes. */
    var mxTip = control("div", { class: "cg-tip" });
    mxTip.hidden = true;
    mxScroll.appendChild(mxTip);
    var mxTable = null;

    function matrixVisible() { return matrix.on; }

    function cellKey(s, t) { return s + "\0" + t; }

    function cssQuote(value) {
      return '"' + String(value).replace(/["\\]/g, "\\$&") + '"';
    }

    /* The matrix of the answer: the kept variables, the projection's legs as
     * cells. A directed leg's number is how many independent routes it stands
     * for, the same count its tooltip gives on the diagram; a bidirected leg
     * is drawn with the correlation marker, both ways round. */
    function computeAnswerMatrix() {
      var Q = window.CausalGraphQuery;
      var a = query.answer, keep = answerKeep(), pr = answerProjection();
      var direct = {}, edgeKeys = [], routes = {}, expandable = {}, notes = {};
      var contracted = {};
      pr.directed.forEach(function (e) {
        var ex = Q.explainEdge(a.model, pr, keep, e[0], e[1], "causal");
        var k = e[0] + "\0" + e[1];
        direct[k] = [[e[0], e[1]]];
        edgeKeys.push([e[0], e[1]]);
        routes[k] = ex.routes || 1;
        expandable[k] = ex.add.length > 0;
        contracted[k] = (ex.through || []).length > 0;
        notes[k] = routes[k] > 1 ? routes[k] + " independent routes"
                 : contracted[k] ? "one route" : "a direct edge";
      });
      var correlated = {};
      pr.bidirected.forEach(function (e) {
        var ex = Q.explainEdge(a.model, pr, keep, e[0], e[1], "correlated");
        var note = ex.irreducible ? "correlated by construction"
                 : ex.latentOnly ? "via a correlation"
                 : "shared upstream: " + ex.via.map(labelOf).join(", ");
        [e[0] + "\0" + e[1], e[1] + "\0" + e[0]].forEach(function (k) {
          correlated[k] = true;
          expandable[k] = ex.add.length > 0;
          notes[k] = note;
        });
      });
      var succ = {};
      keep.forEach(function (k) { succ[k] = []; });
      pr.directed.forEach(function (e) { succ[e[0]].push(e[1]); });
      var reach = {};
      keep.forEach(function (from) {
        var seen = {}, stack = succ[from].slice();
        while (stack.length) {
          var n = stack.pop();
          if (seen[n]) continue;
          seen[n] = true;
          if (n !== from) reach[from + "\0" + n] = true;
          succ[n].forEach(function (c) { stack.push(c); });
        }
      });
      var ordered = bucketOrder(data, keep, edgeKeys);
      var labels = {}, members = {};
      keep.forEach(function (k) {
        labels[k] = labelOf(k);
        members[k] = [k];
      });
      return { answer: true, order: ordered.order, cyclic: ordered.cyclic,
               labels: labels, members: members, roles: answerRoles(keep, pr),
               projection: pr, direct: direct, reach: reach,
               correlated: correlated, routes: routes, contracted: contracted,
               expandable: expandable, notes: notes };
    }

    /* `continuous` says the diagram is tweening into this state rather than
     * being replaced, so what is new in the matrix is worth pointing out:
     * rows and columns that appeared fade in with their headers lit, and
     * cells among the rows that stayed, whose state changed, are outlined. */
    function renderMatrix(continuous) {
      var show = matrixVisible();
      var answer = !!(query.showing && query.answer);
      mxPane.hidden = !show;
      matrixLegend.hidden = !show || answer;
      matrixAnswerLegend.hidden = !show || !answer;
      container.classList.toggle("cg-with-matrix", show);
      if (mxTable) { mxScroll.removeChild(mxTable); mxTable = null; }
      mxTip.hidden = true;
      matrix.current = null;
      container._matrixForTest = null;
      if (!show) { matrix.last = null; return; }
      var mx = answer ? computeAnswerMatrix() : computeMatrix(data, open, labelOf);
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
        return mx.direct[k] ? "direct" : mx.correlated[k] ? "corr" : mx.reach[k] ? "reach" : "";
      }
      var n = mx.order.length;
      var cell = Math.max(8, Math.min(18, Math.floor(540 / Math.max(n, 1))));
      mxPane.style.setProperty("--mx-cell", cell + "px");
      // What a dark cell's number means: routes behind a leg in the answer
      // view, variable-level edges behind a collapsed edge in the model view.
      function countOf(k) {
        return mx.routes ? (mx.routes[k] || 1) : mx.direct[k].length;
      }
      var maxCount = 1;
      Object.keys(mx.direct).forEach(function (k) {
        maxCount = Math.max(maxCount, countOf(k));
      });
      var outdeg = {}, indeg = {};
      mx.order.forEach(function (b) { outdeg[b] = 0; indeg[b] = 0; });
      Object.keys(mx.direct).forEach(function (k) {
        var st = k.split("\0");
        outdeg[st[0]] += countOf(k);
        indeg[st[1]] += countOf(k);
      });
      function colourOf(b) {
        if (mx.roles) return ROLE_COLOUR[mx.roles[b]];
        return PALETTE[(data.rootIndex[rootOf(data, b)] || 0) % PALETTE.length];
      }
      // The line between two top-level groups is drawn by the last cell of
      // the block before it, as its right or bottom border.
      function endsBlock(i) {
        return !mx.roles && i < n - 1 &&
               rootOf(data, mx.order[i]) !== rootOf(data, mx.order[i + 1]);
      }
      // A cell between two variables asks about them; in the answer view a
      // leg that can be opened is the thing to click.
      function clickable(s, t) {
        if (s === t) return false;
        if (mx.answer) return !!mx.expandable[cellKey(s, t)];
        return !isGroupId(s) && !isGroupId(t);
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
      hrow.appendChild(control("th", { class: "cg-mx-sum" }, "out"));
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
          } else if (mx.direct[k]) {
            var count = countOf(k);
            td.classList.add("cg-mx-direct");
            if (mx.contracted && mx.contracted[k]) td.classList.add("cg-mx-leg");
            var alpha = 0.45 + 0.55 * Math.log(1 + count) / Math.log(1 + maxCount);
            td.style.setProperty("--mx-a", alpha.toFixed(2));
            if (count > 1 && cell >= 12) td.textContent = String(count);
          } else if (mx.reach[k]) {
            td.classList.add("cg-mx-reach");
          }
          if (mx.correlated[k]) td.classList.add("cg-mx-corr");
          if (clickable(s, t)) td.classList.add("cg-mx-clickable");
          tr.appendChild(td);
        });
        tr.appendChild(control("td", { class: "cg-mx-sum" }, String(outdeg[s])));
        tbody.appendChild(tr);
      });
      var sums = control("tr", { class: "cg-mx-sums" });
      sums.appendChild(control("th", { class: "cg-mx-sum" }, "in"));
      mx.order.forEach(function (t) {
        sums.appendChild(control("td", { class: "cg-mx-sum" }, String(indeg[t])));
      });
      sums.appendChild(control("td", { class: "cg-mx-sum" }));
      tbody.appendChild(sums);
      table.appendChild(tbody);
      mxScroll.appendChild(table);
      mxTable = table;
      var rows = {};
      mx.order.forEach(function (b) { rows[b] = true; });
      matrix.last = { rows: rows, cells: cells };
      // The marks are a moment's cue, like the diagram's, not a state.
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

    function mxEach(selector, fn) {
      if (!mxTable) return;
      Array.prototype.forEach.call(mxTable.querySelectorAll(selector), fn);
    }

    function mxClear() {
      mxEach(".cg-mx-hl", function (el) { el.classList.remove("cg-mx-hl"); });
    }

    /* Light a bucket's row and column headers, and the cell between two. */
    function mxMark(s, t) {
      mxClear();
      if (!mxTable) return;
      [s, t].forEach(function (b) {
        if (!b) return;
        mxEach("th[data-b=" + cssQuote(b) + "]", function (el) {
          el.classList.add("cg-mx-hl");
        });
      });
      if (s && t && s !== t) {
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

    function mxTipText(s, t, mx) {
      if (s === t) return "";
      var k = cellKey(s, t);
      var lead = mx.labels[s] + " \u2192 " + mx.labels[t];
      if (mx.answer) {
        var more = mx.expandable[k] ? "\n(click to open)" : "";
        if (mx.direct[k]) return lead + ": " + mx.notes[k] + more;
        if (mx.correlated[k]) {
          return mx.labels[s] + " ↔ " + mx.labels[t] + ": " + mx.notes[k] + more;
        }
        if (mx.reach[k]) return lead + ": reaches through the variables shown";
        return lead + ": no causal path";
      }
      var lines = [];
      if (mx.direct[k]) {
        var es = mx.direct[k];
        lines.push(lead + (es.length > 1 ? ": " + es.length + " edges" : ""));
        if (isGroupId(s) || isGroupId(t)) {
          es.slice(0, 8).forEach(function (e) {
            lines.push("\u2003" + labelOf(e[0]) + " \u2192 " + labelOf(e[1]));
          });
          if (es.length > 8) lines.push("\u2003\u2026 and " + (es.length - 8) + " more");
        }
      } else if (mx.reach[k]) {
        lines.push(lead + ": a causal path, no direct edge");
      } else if (mx.correlated[k]) {
        lines.push(mx.labels[s] + " \u2194 " + mx.labels[t] + ": correlated");
      } else {
        lines.push(lead + ": no causal path");
      }
      if (mx.correlated[k] && (mx.direct[k] || mx.reach[k])) {
        lines.push("also correlated");
      }
      if (!isGroupId(s) && !isGroupId(t)) lines.push("(click to query this pair)");
      return lines.join("\n");
    }

    /* Positioned in the pane's own scrolled coordinates. */
    function showMxTip(text, evt) {
      if (!text) { mxTip.hidden = true; return; }
      var size = sizeTip(mxTip, text);
      var room = mxScroll.getBoundingClientRect();
      var px = evt.clientX - room.left, py = evt.clientY - room.top;
      var x = px + 14;
      x = Math.min(x, room.width - size.w - 4);
      var y = py - size.h - 12;
      if (y < 4) y = py + 20;
      mxTip.style.left = Math.round(Math.max(x, 4) + mxScroll.scrollLeft) + "px";
      mxTip.style.top = Math.round(y + mxScroll.scrollTop) + "px";
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
        var edges = [], dir = mx.answer ? "p" : "e", bi = mx.answer ? "q" : "c";
        if (s !== t) {
          if (mx.direct[cellKey(s, t)]) edges.push(dir + s + ">" + t);
          if (mx.correlated[cellKey(s, t)]) edges.push(bi + s + ">" + t, bi + t + ">" + s);
        }
        cyHover([s, t], edges);
        showMxTip(mxTipText(s, t, mx), evt);
      } else if (hit.th) {
        var b = hit.th.getAttribute("data-b");
        mxMark(b, null);
        cyHover([b], []);
        var what = !mx.answer && isGroupId(b)
          ? " (" + mx.members[b].length + " variables)" : "";
        showMxTip(mx.labels[b] + what, evt);
      } else {
        mxClear();
        cyHover([], []);
        mxTip.hidden = true;
      }
    });
    mxPane.addEventListener("mouseleave", function () {
      mxClear();
      cyHover([], []);
      mxTip.hidden = true;
    });
    /* A cell between two variables is a question about them, so clicking it
     * asks it. A header is the node, so clicking it highlights the node. */
    mxPane.addEventListener("click", function (evt) {
      var hit = mxTarget(evt), mx = matrix.current;
      if (hit.td) {
        var s = hit.td.getAttribute("data-s"), t = hit.td.getAttribute("data-t");
        if (s === t) return;
        if (mx && mx.answer) {
          var k = cellKey(s, t);
          if (!mx.expandable[k]) return;
          // The leg on the diagram, for the new variables to start from.
          var leg = cy ? cy.getElementById((mx.direct[k] ? "p" : "q") + s + ">" + t) : null;
          if (leg && leg.empty()) leg = cy.getElementById("q" + t + ">" + s);
          var origin = leg && leg.nonempty() ? midpoint(leg) : null;
          var added = expandAnswerLeg(s, t, mx.direct[k] ? "causal" : "correlated");
          if (added) queryChanged({ ids: keyed(added), origin: origin });
          return;
        }
        if (isGroupId(s) || isGroupId(t)) return;
        if (!query.on) {
          query.on = true;
          queryBtn.classList.add("cg-active");
        }
        setEndpoints(s, t);
      } else if (hit.th && cy) {
        if (mx && mx.answer) return;     // hoverable, not pressable, as on the diagram
        var node = cy.getElementById(hit.th.getAttribute("data-b"));
        if (node.length) toggleHighlight(node);
      }
    });
    mxBtn.addEventListener("click", function () {
      matrix.on = !matrix.on;
      mxBtn.classList.toggle("cg-active", matrix.on);
      renderMatrix();
      saveState();
    });

    /* ---- view state in the fragment (whole-window page only) ---- */

    function saveState() {
      if (!document.body.classList.contains("cg-standalone")) return;
      var groups = Object.keys(open).filter(function (g) { return open[g]; });
      var parts = ["open=" + groups.map(encodeURIComponent).join(",")];
      if (query.on && query.a && query.b) {
        parts.push("q=" + encodeURIComponent(query.a) + "," + encodeURIComponent(query.b));
        var opened = Object.keys(query.extra);
        if (opened.length) parts.push("x=" + opened.map(encodeURIComponent).join(","));
      }
      if (query.context) parts.push("cx=" + encodeURIComponent(query.context));
      if (matrix.on) parts.push("mx=1");
      var hash = "#" + parts.join("&");
      if (window.location.hash !== hash && window.history &&
          window.history.replaceState) {
        window.history.replaceState(null, "", hash);
      }
    }

    function restoreState(state) {
      if (state.q) {
        query.on = true;
        queryBtn.classList.add("cg-active");
        open = openForDepth(data, null);
        query.context = state.cx;
        query.a = state.q[0];
        query.b = state.q[1];
        runQuery();
        query.showing = !!query.answer;
        // Legs opened before the reload, restored as they were.
        state.x.forEach(function (id) { query.extra[id] = true; });
        renderPanel();
      }
      if (state.mx) {
        matrix.on = true;
        mxBtn.classList.add("cg-active");
      }
    }

    queryBtn.addEventListener("click", function () {
      query.on = !query.on;
      queryBtn.classList.toggle("cg-active", query.on);
      // Queries need individual variables, so open everything on entry.
      if (query.on) open = openForDepth(data, null);
      resetQuery();
      draw({ swap: true });
      renderPanel();
    });
    reset.addEventListener("click", function () {
      clearHighlight();
      clampZoom();
    });
    full.addEventListener("click", function () {
      if (fullscreenElement() === container) exitFullscreen();
      else requestFullscreen(container);
    });
    newTab.addEventListener("click", function () {
      var url = standaloneUrl(container, open);
      if (url) window.open(url, "_blank");
    });

    ["fullscreenchange", "webkitfullscreenchange", "msfullscreenchange"]
      .forEach(function (evt) {
        document.addEventListener(evt, function () {
          var on = fullscreenElement() === container;
          container.classList.toggle("cg-fullscreen", on);
          full.textContent = on ? "Exit fullscreen" : "Fullscreen";
          if (cy) { cy.resize(); clampZoom(); }
        });
      });

    restoreState(saved);
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
