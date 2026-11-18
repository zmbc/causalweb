/* Causal queries over the graph, as the viewer asks them: whether one of two
 * variables causes the other, whether they share causes, and a summary of the
 * graph for any set of visible variables, which opens one step at a time.
 *
 * Everything here runs on the FULL variable-level graph, regardless of which
 * groups happen to be open on screen. A group-level edge does not mean every
 * variable in the source affects every variable in the target, so the
 * collapsed view is for navigation only and must never be the basis of an
 * answer.
 *
 * A declared correlation becomes a latent parent of the two variables. Path
 * tracing then treats the correlation as a common cause.
 *
 * Nothing here conditions on a set of variables. Conditioning, D-separation
 * and back-door tests are in causalweb_adjustment.js, which the viewer does
 * not use yet.
 */
window.CausalGraphQuery = (function () {
  "use strict";

  function keys(o) { return Object.keys(o); }
  function setOf(list) {
    var s = {};
    (list || []).forEach(function (k) { s[k] = true; });
    return s;
  }

  /* ---- model ---------------------------------------------------------- */

  function build(data) {
    var parents = {}, children = {}, latent = {};
    data.nodes.forEach(function (n) {
      parents[n.id] = [];
      children[n.id] = [];
    });
    data.edges.forEach(function (e) {
      if (!parents[e.target] || !children[e.source]) return;
      parents[e.target].push(e.source);
      children[e.source].push(e.target);
    });
    var declared = {};
    (data.correlated || []).forEach(function (pair, i) {
      var u = "__latent" + i;
      parents[u] = [];
      children[u] = [pair[0], pair[1]];
      latent[u] = true;
      parents[pair[0]].push(u);
      parents[pair[1]].push(u);
      // both orderings, so a lookup needs no sorting
      declared[pair[0] + ">" + pair[1]] = true;
      declared[pair[1] + ">" + pair[0]] = true;
    });
    var label = {}, deterministic = {};
    data.nodes.forEach(function (n) {
      label[n.id] = n.label;
      deterministic[n.id] = !!n.deterministic;
    });
    var m = { parents: parents, children: children, latent: latent,
              label: label,
              deterministic: deterministic,
              // correlations the graph declares, as "a>b" both ways round
              declared: declared,
              // variables with no variation in the selected context
              held: {} };

    // Edges the context says are not there, before anything reads the graph.
    (data.inactiveEdges || []).forEach(function (e) { unlink(m, e[0], e[1]); });

    /* Constants, and everything that is an exact function of them.
     *
     * A constant transmits no variation, so it can neither confound nor
     * carry an influence, and conditioning on it says nothing, so it cannot
     * open a collider path either. Cutting its edges makes every later step
     * agree about that: D-separation, adjustment sets, the projection and its
     * explanations. */
    m.held = determined(m, data.fixed || []);
    keys(m.held).forEach(function (v) {
      (m.children[v] || []).slice().forEach(function (c) { unlink(m, v, c); });
      (m.parents[v] || []).slice().forEach(function (p) { unlink(m, p, v); });
    });
    return m;
  }

  function unlink(m, source, target) {
    if (m.children[source]) {
      m.children[source] = m.children[source].filter(function (c) {
        return c !== target;
      });
    }
    if (m.parents[target]) {
      m.parents[target] = m.parents[target].filter(function (p) {
        return p !== source;
      });
    }
  }

  function ancestors(m, seed) {
    var seen = setOf(seed), stack = (seed || []).slice();
    while (stack.length) {
      var n = stack.pop();
      (m.parents[n] || []).forEach(function (p) {
        if (!seen[p]) { seen[p] = true; stack.push(p); }
      });
    }
    return seen;
  }

  function descendants(m, seed) {
    var seen = setOf(seed), stack = (seed || []).slice();
    while (stack.length) {
      var n = stack.pop();
      (m.children[n] || []).forEach(function (c) {
        if (!seen[c]) { seen[c] = true; stack.push(c); }
      });
    }
    return seen;
  }

  /* Everything that conditioning on Z pins down.
   *
   * A deterministic variable whose every parent is already fixed is itself
   * fixed, so the closure is taken to a fixed point. A deterministic variable
   * with no parents is a constant and is likewise determined. */
  function determined(m, Z) {
    /* Constants are fixed whether or not anything was conditioned on. A
     * variable held at one value has nothing to vary with, so it blocks paths
     * through it and can never confound. */
    var fixed = setOf(Z);
    keys(m.held || {}).forEach(function (v) { fixed[v] = true; });
    var changed = true;
    while (changed) {
      changed = false;
      keys(m.parents).forEach(function (v) {
        if (fixed[v] || !m.deterministic[v]) return;
        var ps = m.parents[v] || [];
        var all = ps.every(function (p) { return fixed[p]; });
        if (all) { fixed[v] = true; changed = true; }
      });
    }
    return fixed;
  }

  /* The model with x's outgoing edges removed, so nothing found in it can be
   * x's own influence on anything. */
  function withoutOutgoing(m, x) {
    var cut = {
      parents: {}, children: {}, latent: m.latent,
      label: m.label, deterministic: m.deterministic, held: m.held,
    };
    keys(m.parents).forEach(function (n) { cut.parents[n] = m.parents[n].slice(); });
    keys(m.children).forEach(function (n) { cut.children[n] = m.children[n].slice(); });
    (m.children[x] || []).forEach(function (c) {
      cut.parents[c] = cut.parents[c].filter(function (p) { return p !== x; });
    });
    cut.children[x] = [];
    return cut;
  }

  /* The narrowest waist of a leg: the smallest set of variables that every
   * route between its ends passes through. A leg stands for every directed
   * route between two variables, and usually no single variable lies on all
   * of them.
   *
   * Minimum vertex cut by max flow, each interior variable split into an entry
   * and an exit joined by a unit edge, so a saturated edge is a chosen
   * variable. The cut returned is the one nearest the source, which reads as
   * "what happens first". Other minimum cuts of the same size exist. */
  function legWaist(m, from, to, keep) {
    /* Only routes the leg actually stands for. The projection stops at kept
     * variables, so a route through one of them is drawn as its own pair of
     * legs and must not be cut here. */
    var off = setOf(keep || []);
    var mid = descendants(m, [from]);
    var up = ancestors(m, [to]);
    var inner = keys(mid).filter(function (v) {
      return up[v] && v !== from && v !== to && !off[v];
    });
    /* A direct edge is a route with no interior, so no choice of interior
     * variables can intercept it. It stays out of the flow network: every
     * source-to-sink path there has to cross a unit-capacity split edge. */
    if (!inner.length) return [];

    var innerSet = setOf(inner);
    var cap = {}, adj = {};
    function link(a, b, c) {
      cap[a + "\0" + b] = (cap[a + "\0" + b] || 0) + c;
      (adj[a] = adj[a] || {})[b] = true;
      (adj[b] = adj[b] || {})[a] = true;
    }
    var BIG = 1e6;
    var S = from + "|out", T = to + "|in";
    inner.forEach(function (v) { link(v + "|in", v + "|out", 1); });
    inner.concat([from]).forEach(function (v) {
      (m.children[v] || []).forEach(function (c) {
        if (innerSet[c]) link(v + "|out", c + "|in", BIG);
        // the direct from->to edge stays out: see above
        else if (c === to && v !== from) link(v + "|out", T, BIG);
      });
    });

    function residualReach() {
      var seen = {}, stack = [S];
      seen[S] = true;
      while (stack.length) {
        var u = stack.pop();
        keys(adj[u] || {}).forEach(function (w) {
          if (!seen[w] && (cap[u + "\0" + w] || 0) > 0) {
            seen[w] = true; stack.push(w);
          }
        });
      }
      return seen;
    }

    for (;;) {
      // one augmenting path at a time; capacities here are tiny integers
      var prev = {}, stack = [S], found = false;
      prev[S] = null;
      while (stack.length && !found) {
        var u = stack.pop();
        var ws = keys(adj[u] || {});
        for (var i = 0; i < ws.length; i++) {
          var w = ws[i];
          if (!(w in prev) && (cap[u + "\0" + w] || 0) > 0) {
            prev[w] = u;
            if (w === T) { found = true; break; }
            stack.push(w);
          }
        }
      }
      if (!found) break;
      var path = [], node = T;
      while (prev[node] !== null && prev[node] !== undefined) {
        path.push([prev[node], node]);
        node = prev[node];
      }
      var bottleneck = Infinity;
      path.forEach(function (e) {
        bottleneck = Math.min(bottleneck, cap[e[0] + "\0" + e[1]] || 0);
      });
      path.forEach(function (e) {
        cap[e[0] + "\0" + e[1]] -= bottleneck;
        cap[e[1] + "\0" + e[0]] = (cap[e[1] + "\0" + e[0]] || 0) + bottleneck;
      });
    }

    var side = residualReach();
    var waist = inner.filter(function (v) {
      return side[v + "|in"] && !side[v + "|out"];
    });
    return waist.sort();
  }

  /* ---- latent projection ---------------------------------------------- */

  /* The bidirected edges of the projection onto `keep`, which preserves
   * every d-separation among those variables: common causes that are
   * projected out reappear as bidirected edges. So the answer to "is this
   * confounded" becomes a visible `<->`. `forks` holds the projected-out common causes behind each one.
   * (The directed edges, chains through projected-out nodes, are the
   * summary's legs.) */
  function project(m, keep) {
    var K = setOf(keep);
    function reach(from) {
      var out = {}, stack = (m.children[from] || []).slice(), seen = {};
      while (stack.length) {
        var n = stack.pop();
        if (seen[n]) continue;
        seen[n] = true;
        if (K[n]) { out[n] = true; continue; }       // stop at kept nodes
        (m.children[n] || []).forEach(function (c) { stack.push(c); });
      }
      return out;
    }
    var reachOf = {};
    keys(m.parents).forEach(function (n) { if (!K[n]) reachOf[n] = reach(n); });

    var bidirected = [], forks = {};
    keys(m.parents).forEach(function (c) {
      if (K[c]) return;                               // only projected-out forks
      var hits = keys(reachOf[c]).sort();
      for (var i = 0; i < hits.length; i++) {
        for (var j = i + 1; j < hits.length; j++) {
          var key = hits[i] + "|" + hits[j];
          (forks[key] = forks[key] || []).push(c);
        }
      }
    });
    keys(forks).forEach(function (key) {
      var pair = key.split("|");
      bidirected.push([pair[0], pair[1]]);
    });
    return { bidirected: bidirected, forks: forks };
  }

  /* ---- explaining a projected edge ------------------------------------ */

  /* The variables a contracted directed edge passed through.
   *
   * A projected edge a -> b stands for one or more paths whose intermediate
   * nodes were all projected away. These are those intermediates: reachable
   * forward from a and backward from b without crossing a kept node. */
  function pathNodes(m, a, b, keep) {
    var K = setOf(keep);
    function sweep(start, key) {
      var seen = {}, stack = (m[key][start] || []).slice();
      while (stack.length) {
        var n = stack.pop();
        if (seen[n] || K[n]) continue;
        seen[n] = true;
        (m[key][n] || []).forEach(function (v) { stack.push(v); });
      }
      return seen;
    }
    var fwd = sweep(a, "children");
    var bwd = sweep(b, "parents");
    return keys(fwd).filter(function (n) { return bwd[n]; }).sort();
  }

  function uniqueSorted(list) {
    var seen = {}, out = [];
    list.forEach(function (k) { if (!seen[k]) { seen[k] = true; out.push(k); } });
    return out.sort();
  }

  /* ---- the summary for a set of visible variables --------------------- */

  /* The summary is the latent projection onto the visible variables, with one
   * change: a leg (a directed edge that stands for routes through hidden
   * variables) is split into one leg per part of its hidden variables, where
   * no edge joins two parts. So routes that share no variable are drawn as
   * separate legs. Solid edges are the graph's own edges between visible
   * variables. A <-> stands for a hidden common cause, or a declared
   * correlation, that reaches both ends through hidden variables only. Like
   * the projection, the summary keeps every d-separation among the visible
   * variables, and with every variable visible it is the graph itself. */

  /* Each variable's position in an order where every cause comes before its
   * effects. Ties keep the order of the file. */
  function causalOrder(m) {
    if (m.order) return m.order;
    var indegree = {}, order = {}, ready = [], next = 0;
    keys(m.parents).forEach(function (v) {
      if (m.latent[v]) return;
      indegree[v] = (m.parents[v] || []).filter(function (p) {
        return !m.latent[p];
      }).length;
      if (!indegree[v]) ready.push(v);
    });
    while (ready.length) {
      var v = ready.shift();
      order[v] = next++;
      (m.children[v] || []).forEach(function (c) {
        indegree[c] -= 1;
        if (!indegree[c]) ready.push(c);
      });
    }
    m.order = order;
    return order;
  }

  /* Visible variables reachable from a through hidden variables only, not
   * counting a's own edges to visible variables. */
  function legTargets(m, a, V) {
    var out = {}, seen = {}, stack = [];
    (m.children[a] || []).forEach(function (c) { if (!V[c]) stack.push(c); });
    while (stack.length) {
      var n = stack.pop();
      if (seen[n]) continue;
      seen[n] = true;
      (m.children[n] || []).forEach(function (c) {
        if (V[c]) out[c] = true;
        else stack.push(c);
      });
    }
    return keys(out).sort();
  }

  /* Split hidden variables into parts that no edge joins. */
  function parts(m, hidden) {
    var H = setOf(hidden), seen = {}, out = [];
    hidden.slice().sort().forEach(function (start) {
      if (seen[start]) return;
      var part = [], stack = [start];
      seen[start] = true;
      while (stack.length) {
        var n = stack.pop();
        part.push(n);
        (m.children[n] || []).concat(m.parents[n] || []).forEach(function (v) {
          if (H[v] && !seen[v]) { seen[v] = true; stack.push(v); }
        });
      }
      out.push(part.sort());
    });
    return out;
  }

  /* Everything except `inside` and the two ends, for legWaist to ignore. */
  function outside(m, inside, a, b) {
    var I = setOf(inside.concat([a, b]));
    return keys(m.parents).filter(function (n) { return !I[n]; });
  }

  function summarize(m, visible) {
    var vis = uniqueSorted(visible);
    var V = setOf(vis);
    var order = causalOrder(m);
    var solid = [], legs = [], bidirected = [];

    vis.forEach(function (a) {
      (m.children[a] || []).forEach(function (c) {
        if (V[c]) solid.push({ id: "s|" + a + "|" + c, kind: "solid", source: a, target: c });
      });
    });

    vis.forEach(function (a) {
      legTargets(m, a, V).forEach(function (b) {
        parts(m, pathNodes(m, a, b, vis)).forEach(function (part, k) {
          legs.push({
            id: "l|" + a + "|" + b + "|" + k, kind: "leg", source: a, target: b,
            hidden: part, expandable: true,
          });
        });
      });
    });

    var pr = project(m, vis);
    pr.bidirected.forEach(function (pair) {
      var a = pair[0], b = pair[1];
      var forks = (pr.forks[a + "|" + b] || []).slice().sort();
      // a declared correlation joining exactly these two cannot be opened
      var declared = forks.filter(function (f) {
        var kids = (m.children[f] || []).slice().sort();
        return m.latent[f] && kids.length === 2 && kids[0] === a && kids[1] === b;
      });
      /* A <-> has no direction, but a layered layout treats every edge as
       * pointing from source to target. Pointing it along the causal order
       * keeps the picture free of cycles, so the layout never has to turn a
       * directed edge upward to break one. */
      var first = order[a] <= order[b] ? a : b;
      bidirected.push({
        id: "b|" + a + "|" + b, kind: "bi", source: first, target: first === a ? b : a,
        declared: declared.length > 0,
        expandable: forks.length > declared.length,
      });
    });

    return { visible: vis, solid: solid, legs: legs, bidirected: bidirected };
  }

  function elements(s) {
    return s.solid.concat(s.legs, s.bidirected);
  }

  /* ---- the common causes behind a <-> --------------------------------- */

  /* Hidden ancestors of x that reach it through hidden variables only,
   * leaving out the latent parents in `skip`. */
  function hiddenAncestors(m, x, V, skip) {
    var seen = {}, stack = [x];
    while (stack.length) {
      (m.parents[stack.pop()] || []).forEach(function (p) {
        if (!V[p] && !skip[p] && !seen[p]) { seen[p] = true; stack.push(p); }
      });
    }
    return seen;
  }

  /* Declared correlations that join a and b themselves. Nothing hidden
   * explains them, so they are left out of the search for causes. */
  function directCorrelations(m, a, b) {
    var out = {};
    keys(m.latent).forEach(function (u) {
      var kids = (m.children[u] || []).slice().sort();
      if (kids.length === 2 && kids[0] === [a, b].sort()[0] && kids[1] === [a, b].sort()[1]) {
        out[u] = true;
      }
    });
    return out;
  }

  /* The smallest set of hidden variables that every chain of shared causes
   * between a and b passes through, nearest a. A chain goes up from a through
   * hidden variables to a common cause, and down from there through hidden
   * variables to b. Common causes are what explains a <->, so only they may
   * be in the set, and the variables a declared correlation joins, since
   * they stand in for its cause. Every chain turns at a common cause, so a
   * set exists whenever a chain does.
   *
   * A minimum cut, by max flow over two copies of the hidden variables: the
   * chain's way up, and its way down from the common cause. Each variable is
   * split into an entry and an exit joined by an edge whose capacity is its
   * cost; every other edge is unlimited. A variable on the way up and on the
   * way down of different chains is paid for on each, so the cut found from
   * one end can be larger than it needs to be; candidates come from both
   * ends. */
  function causeCut(m, visible, a, b) {
    var V = setOf(visible), skip = directCorrelations(m, a, b);
    var upA = hiddenAncestors(m, a, V, skip), upB = hiddenAncestors(m, b, V, skip);
    var cause = {};
    keys(upA).forEach(function (v) { if (upB[v]) cause[v] = true; });
    var stands = {};          // variables a declared correlation behind the pair joins
    keys(cause).forEach(function (u) {
      if (m.latent[u]) (m.children[u] || []).forEach(function (c) { stands[c] = true; });
    });
    var INF = 1e9, cap = {}, adj = {};
    function cost(v) {
      if (m.latent[v]) return INF;
      return cause[v] || stands[v] ? 1 : INF;
    }
    function link(x, y, c) {
      cap[x + "\0" + y] = (cap[x + "\0" + y] || 0) + c;
      (adj[x] = adj[x] || {})[y] = true;
      (adj[y] = adj[y] || {})[x] = true;
    }
    var S = "|S", T = "|T";
    keys(upA).forEach(function (v) { link("u>" + v, "u<" + v, cost(v)); });
    keys(upB).forEach(function (v) { link("d>" + v, "d<" + v, cost(v)); });
    (m.parents[a] || []).forEach(function (p) { if (upA[p]) link(S, "u>" + p, INF); });
    keys(upA).forEach(function (v) {
      (m.parents[v] || []).forEach(function (p) { if (upA[p]) link("u<" + v, "u>" + p, INF); });
      if (!cause[v]) return;
      // the chain turns at a common cause and goes down towards b
      (m.children[v] || []).forEach(function (c) {
        if (c === b) link("u<" + v, T, INF);
        else if (upB[c]) link("u<" + v, "d>" + c, INF);
      });
    });
    keys(upB).forEach(function (v) {
      (m.children[v] || []).forEach(function (c) {
        if (c === b) link("d<" + v, T, INF);
        else if (upB[c]) link("d<" + v, "d>" + c, INF);
      });
    });

    var flow = 0;
    for (;;) {
      var prev = {}, queue = [S], found = false;
      prev[S] = null;
      while (queue.length && !found) {
        var u = queue.shift(), ws = keys(adj[u] || {});
        for (var i = 0; i < ws.length; i++) {
          var w = ws[i];
          if (!(w in prev) && (cap[u + "\0" + w] || 0) > 0) {
            prev[w] = u;
            if (w === T) { found = true; break; }
            queue.push(w);
          }
        }
      }
      if (!found) break;
      var bottleneck = INF, n = T;
      while (prev[n] !== null) { bottleneck = Math.min(bottleneck, cap[prev[n] + "\0" + n]); n = prev[n]; }
      n = T;
      while (prev[n] !== null) {
        var q = prev[n];
        cap[q + "\0" + n] -= bottleneck;
        cap[n + "\0" + q] = (cap[n + "\0" + q] || 0) + bottleneck;
        n = q;
      }
      flow += bottleneck;
      if (flow >= INF) return null;
    }
    var side = {}, stack = [S];
    side[S] = true;
    while (stack.length) {
      var x = stack.pop();
      keys(adj[x] || {}).forEach(function (y) {
        if (!side[y] && (cap[x + "\0" + y] || 0) > 0) { side[y] = true; stack.push(y); }
      });
    }
    var cut = {};
    keys(upA).forEach(function (v) { if (side["u>" + v] && !side["u<" + v]) cut[v] = true; });
    keys(upB).forEach(function (v) { if (side["d>" + v] && !side["d<" + v]) cut[v] = true; });
    return keys(cut).sort();
  }

  /* Whether revealing `set` leaves no chain of shared causes between a and
   * b: no hidden variable reaches both through hidden variables only. A
   * declared correlation between a and b themselves is left out. */
  function blocks(m, visible, a, b, set) {
    var V = setOf(visible.concat(set)), skip = directCorrelations(m, a, b);
    var upA = hiddenAncestors(m, a, V, skip), upB = hiddenAncestors(m, b, V, skip);
    return !keys(upA).some(function (v) { return upB[v]; });
  }

  // whether a member of `set` lies downstream of another member
  function nested(m, set) {
    var S = setOf(set);
    return set.some(function (v) {
      var seen = {}, stack = (m.children[v] || []).slice();
      while (stack.length) {
        var n = stack.pop();
        if (S[n]) return true;
        if (seen[n]) continue;
        seen[n] = true;
        (m.children[n] || []).forEach(function (c) { stack.push(c); });
      }
      return false;
    });
  }

  /* The better of the cuts found from each end, with any member left out
   * that the others do without. A member that only stands in for a declared
   * correlation's cause counts as two. */
  function causeSet(m, visible, a, b) {
    var V = setOf(visible), none = {};
    var upA = hiddenAncestors(m, a, V, none), upB = hiddenAncestors(m, b, V, none);
    function cost(set) {
      return set.reduce(function (n, v) { return n + (upA[v] && upB[v] ? 1 : 2); }, 0);
    }
    // of two equally small sets, one with no member downstream of another
    // reads as alternatives, which is what it is
    var found = [causeCut(m, visible, a, b), causeCut(m, visible, b, a)]
      .filter(Boolean).sort(function (x, y) {
        return cost(x) - cost(y) || (nested(m, x) ? 1 : 0) - (nested(m, y) ? 1 : 0);
      });
    if (!found.length) return null;
    var set = found[0].slice();
    set.slice().forEach(function (v) {
      var rest = set.filter(function (u) { return u !== v; });
      if (rest.length && blocks(m, visible, a, b, rest)) set = rest;
    });
    return set;
  }

  /* Variables of a leg that every one of its routes passes through, each with
   * how unevenly it splits the leg's other hidden variables. */
  function seriesVariables(m, leg) {
    var a = leg.source, b = leg.target, P = setOf(leg.hidden), out = [];
    leg.hidden.forEach(function (v) {
      var up = {}, stack = [], reached = false;
      (m.children[a] || []).forEach(function (c) { if (P[c] && c !== v) stack.push(c); });
      while (stack.length) {
        var n = stack.pop();
        if (up[n]) continue;
        up[n] = true;
        (m.children[n] || []).forEach(function (c) {
          if (c === b) reached = true;
          else if (P[c] && c !== v) stack.push(c);
        });
      }
      if (reached) return;
      var before = keys(up).length;
      out.push({ v: v, uneven: Math.abs(before - (leg.hidden.length - 1 - before)) });
    });
    return out;
  }

  /* ---- the route of a leg, in a few steps ----------------------------- */

  /* Hidden variables of the leg on routes from x to y that pass no stop. */
  function stretch(m, x, y, P, stops) {
    function sweep(start, key) {
      var seen = {}, stack = (m[key][start] || []).slice();
      while (stack.length) {
        var n = stack.pop();
        if (seen[n] || !P[n] || stops[n]) continue;
        seen[n] = true;
        (m[key][n] || []).forEach(function (v) { stack.push(v); });
      }
      return seen;
    }
    var fwd = sweep(x, "children"), bwd = sweep(y, "parents");
    return keys(fwd).filter(function (n) { return bwd[n]; });
  }

  /* For each variable of `inner`, the share of the routes from x to y
   * through `inner` that pass it. */
  function routeShares(m, x, y, inner) {
    var order = causalOrder(m), I = setOf(inner);
    var sorted = inner.slice().sort(function (u, v) { return order[u] - order[v]; });
    var up = {}, down = {}, out = {};
    sorted.forEach(function (v) {
      up[v] = (m.parents[v] || []).reduce(function (t, p) {
        return t + (p === x ? 1 : I[p] ? up[p] || 0 : 0);
      }, 0);
    });
    sorted.slice().reverse().forEach(function (v) {
      down[v] = (m.children[v] || []).reduce(function (t, c) {
        return t + (c === y ? 1 : I[c] ? down[c] || 0 : 0);
      }, 0);
    });
    var total = (m.children[x] || []).reduce(function (t, c) { return t + (I[c] ? down[c] : 0); }, 0);
    sorted.forEach(function (v) { out[v] = total ? up[v] * down[v] / total : 0; });
    return out;
  }

  /* The route of a leg in a few steps, for its tooltip.
   *
   * A variable that every route passes is a step of its own, in causal
   * order: { names: [v] }. Between two such variables, or an end, the routes
   * run side by side. There the smallest set of variables they all pass,
   * nearest the start, is a step: { names: [...], set: true }, the variables
   * that most routes pass first. The hidden variables before that set, and
   * after it, are each a gap: { gap: true }. A stretch that a direct edge
   * skips is one gap as a whole, since not every route passes its set. */
  function routeSteps(m, leg) {
    var order = causalOrder(m), P = setOf(leg.hidden);
    function byOrder(u, v) { return order[u] - order[v]; }
    var series = seriesVariables(m, leg).map(function (x) { return x.v; }).sort(byOrder);
    var stopList = [leg.source].concat(series, [leg.target]);
    var stops = setOf(stopList), steps = [];
    for (var i = 0; i + 1 < stopList.length; i++) {
      var x = stopList[i], y = stopList[i + 1];
      var inner = stretch(m, x, y, P, stops);
      if (inner.length) {
        // a direct edge between the leg's own ends is drawn apart from it
        var ends = x === leg.source && y === leg.target;
        if (!ends && (m.children[x] || []).indexOf(y) >= 0) {
          steps.push({ gap: true });
        } else {
          var share = routeShares(m, x, y, inner);
          var cut = legWaist(m, x, y, outside(m, inner, x, y)).sort(function (u, v) {
            return share[v] - share[u] || byOrder(u, v);
          });
          // before the set: what some route reaches without passing a member
          var C = setOf(cut), inside = setOf(inner), early = {}, stack = [x];
          while (stack.length) {
            (m.children[stack.pop()] || []).forEach(function (c) {
              if (inside[c] && !C[c] && !early[c]) { early[c] = true; stack.push(c); }
            });
          }
          var before = inner.some(function (n) { return early[n]; });
          var after = inner.some(function (n) { return !C[n] && !early[n]; });
          if (before) steps.push({ gap: true });
          steps.push({ names: cut, set: true });
          if (after) steps.push({ gap: true });
        }
      }
      if (i + 2 < stopList.length) steps.push({ names: [y] });
    }
    return steps;
  }

  // the variables in causal order
  function inOrder(m, ids) {
    var order = causalOrder(m);
    return ids.slice().sort(function (u, v) { return order[u] - order[v]; });
  }

  /* ---- any directed graph --------------------------------------------- */

  /* These take a graph as its `nodes` and its `edges`, each edge a
   * [source, target] pair. The edges may form cycles. */

  /* The nodes with causes before effects. Of the nodes ready at each step,
   * the one first in `rank`, a map from node to number, comes next. Nodes on
   * a cycle, and those after one, cannot be placed: they are `left`, in rank
   * order. */
  function topoOrder(nodes, edges, rank) {
    var succ = {}, indeg = {}, seen = {};
    nodes.forEach(function (n) { succ[n] = []; indeg[n] = 0; });
    edges.forEach(function (e) {
      var k = e[0] + "\0" + e[1];
      if (e[0] === e[1] || seen[k]) return;
      seen[k] = true;
      succ[e[0]].push(e[1]);
      indeg[e[1]] += 1;
    });
    function byRank(a, b) { return rank[a] - rank[b]; }
    var ready = nodes.filter(function (n) { return !indeg[n]; }), order = [], done = {};
    while (ready.length) {
      ready.sort(byRank);
      var n = ready.shift();
      order.push(n);
      done[n] = true;
      succ[n].forEach(function (t) { if (--indeg[t] === 0) ready.push(t); });
    }
    var left = nodes.filter(function (n) { return !done[n]; }).sort(byRank);
    return { order: order, left: left };
  }

  /* How the nodes depend on each other, where `links` ([a, b] pairs) are
   * <-> between them. `reach[a][b]` when a path of edges leads from a to b.
   * `apart[a][b]`, and `apart[b][a]`, when a and b are correlated other
   * than by such a path or a link between them: through a shared cause, or
   * a link from one of them, or from a cause of one, to a cause of the
   * other. With nothing conditioned on, that is a common ancestor of the
   * two once the edges out of both, and the link between them, are left
   * out. */
  function dependence(nodes, edges, links) {
    var parents = {}, children = {}, reach = {}, apart = {};
    nodes.forEach(function (n) {
      parents[n] = []; children[n] = []; reach[n] = {}; apart[n] = {};
    });
    edges.forEach(function (e) {
      parents[e[1]].push(e[0]);
      children[e[0]].push(e[1]);
    });
    nodes.forEach(function (from) {
      var seen = {}, stack = children[from].slice();
      while (stack.length) {
        var n = stack.pop();
        if (seen[n]) continue;
        seen[n] = true;
        if (n !== from) reach[from][n] = true;
        children[n].forEach(function (c) { stack.push(c); });
      }
    });
    // `v` and its ancestors, along paths that do not pass `avoid`
    function upFrom(v, avoid) {
      var seen = {}, stack = [v];
      seen[v] = true;
      while (stack.length) {
        parents[stack.pop()].forEach(function (p) {
          if (p !== avoid && !seen[p]) { seen[p] = true; stack.push(p); }
        });
      }
      return seen;
    }
    for (var i = 0; i < nodes.length; i++) {
      for (var j = i + 1; j < nodes.length; j++) {
        var x = nodes[i], y = nodes[j];
        var up = upFrom(x, y), upY = upFrom(y, x);
        var joined = keys(up).some(function (v) { return upY[v]; }) ||
          links.some(function (l) {
            var u = l[0], w = l[1];
            if (u === x && w === y || u === y && w === x) return false;
            return up[u] && upY[w] || up[w] && upY[u];
          });
        if (joined) apart[x][y] = apart[y][x] = true;
      }
    }
    return { reach: reach, apart: apart };
  }

  return {
    build: build,
    ancestors: ancestors,
    determined: determined,
    withoutOutgoing: withoutOutgoing,
    summarize: summarize,
    elements: elements,
    routeSteps: routeSteps,
    inOrder: inOrder,
    causeCut: causeCut,
    causeSet: causeSet,
    topoOrder: topoOrder,
    dependence: dependence,
  };
})();
