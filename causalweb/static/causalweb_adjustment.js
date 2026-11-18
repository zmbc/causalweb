/* Conditioning and back-door tests, kept for adjustment sets.
 *
 * The viewer does not use this file, and no page loads it. It builds on
 * `window.CausalGraphQuery` from causalweb_query.js, which has to load first.
 * A model `m` here is the result of `CausalGraphQuery.build`.
 *
 * TWO THINGS THAT MAKE THIS A SIMULATION:
 *
 * 1. Every variable is observed. There is no measurement problem, so an
 *    adjustment set may contain anything that is not a descendant of the
 *    cause. The correlated variables are still drawn as a shared latent,
 *    because that is what their joint draw amounts to and it is what makes
 *    path-tracing come out right -- but the latent itself is outside the
 *    simulation, so it cannot be conditioned on. Its *children* can: blocking a
 *    path through the correlation means conditioning on the other variable,
 *    which is perfectly observable.
 *
 * 2. Many variables are exact functions of their causes (`deterministic`).
 *    Conditioning on such a node's parents fixes the node too, which blocks
 *    paths that plain d-separation leaves open. So the tests below use
 *    D-separation: the conditioning set is first closed under determinism, and
 *    that closure is what blocks. Ignoring this would report confounding that
 *    cannot exist.
 */
window.CausalGraphAdjustment = (function (Q) {
  "use strict";

  function keys(o) { return Object.keys(o); }
  function setOf(list) {
    var s = {};
    (list || []).forEach(function (k) { s[k] = true; });
    return s;
  }

  /* ---- D-separation, via the ancestral moral graph --------------------- */

  /* Blocking uses the determinism closure of Z. A node
   * fixed by Z behaves exactly as if it had been conditioned on: it blocks
   * non-colliders, and it opens colliders below it. Substituting the closure
   * throughout is what turns d-separation into D-separation. */
  function dSeparated(m, X, Y, Z) {
    var D = Q.determined(m, Z);
    var cond = keys(D);
    var A = Q.ancestors(m, X.concat(Y).concat(cond));
    var adj = {};
    function link(a, b) {
      (adj[a] = adj[a] || {})[b] = true;
      (adj[b] = adj[b] || {})[a] = true;
    }
    keys(A).forEach(function (n) {
      var ps = (m.parents[n] || []).filter(function (p) { return A[p]; });
      ps.forEach(function (p) { link(p, n); });
      // moralise: co-parents of a common child become adjacent
      for (var i = 0; i < ps.length; i++) {
        for (var j = i + 1; j < ps.length; j++) link(ps[i], ps[j]);
      }
    });
    var target = setOf(Y);
    var seen = {}, stack = [];
    X.forEach(function (x) {
      if (!D[x]) { seen[x] = true; stack.push(x); }
    });
    while (stack.length) {
      var n = stack.pop();
      if (target[n]) return false;
      keys(adj[n] || {}).forEach(function (v) {
        if (!seen[v] && !D[v]) { seen[v] = true; stack.push(v); }
      });
    }
    return true;
  }

  /* Is there an open back-door path from x to y given Z? */
  function confounded(m, x, y, Z) {
    return !dSeparated(Q.withoutOutgoing(m, x), [x], [y], Z || []);
  }

  return {
    dSeparated: dSeparated,
    confounded: confounded,
  };
})(window.CausalGraphQuery);
