"""Hierarchical causal graphs for simulation models.

A graph is written in YAML (schema in ``causalweb.model``), validated on
load, and shown in the browser at any level of its group hierarchy, with
causal queries (confounding, shared causes, latent projection) answered on the
full variable-level graph. ``causalweb.sphinx_ext`` embeds graphs in Sphinx
documentation. ``causalweb.cli`` serves one from the command line with live
reloading.
"""

from .model import CausalGraph, GraphError, Matrix, load_graph

__version__ = "0.1.0"
__all__ = ["CausalGraph", "GraphError", "Matrix", "load_graph", "__version__"]
