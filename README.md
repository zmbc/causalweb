# causalweb

Hierarchical causal graphs for models of real-world processes: a YAML schema,
an interactive viewer, a Sphinx extension and a live-reloading command line.

A graph is written once, at the level of individual variables, with the
variables grouped into nested modules. The viewer shows it at any level of
that hierarchy. Closed groups become single nodes whose edges summarise the
edges of their members. The viewer also answers causal questions on the full
graph (d-separation, confounding, shared causes, the latent projection onto a
chosen set of variables) and shows the same graph as an adjacency matrix.

## Install

    pip install git+https://github.com/zmbc/causalweb.git

For development, clone the repository and run `pip install -e .` in it.
Python 3.9 or later and PyYAML are the only requirements. The viewer loads
Cytoscape and ELK from a CDN in the browser.

## Command line

    causalweb serve graph.yaml             # live view, reloads when the file changes
    causalweb serve graph.yaml --collapse 1 --port 0 --open
    causalweb check graph.yaml             # validate; exit 1 on problems
    causalweb build graph.yaml -o out.html # one self-contained page
    causalweb matrix graph.yaml --depth 1  # adjacency matrix in the terminal

`serve` listens on port 8765, or the next free port when that one is taken.
An explicit `--port` is strict. `--port 0` takes any free port.

Two example graphs are in `examples/`. Try

    causalweb serve examples/preeclampsia_real_world.yaml

## The YAML schema

The schema is documented in [causalweb/model.py](causalweb/model.py). In
outline, a file has these top-level keys:

- `level_labels`: names for the levels of the group hierarchy, outermost first.
- `groups`: each with a `name`, a `label`, and `contains`, the names of the
  groups and variables inside it, in display order.
- `nodes`: the variables, each with a `name`, a `label`, `caused_by` (the
  names of its direct causes), and optionally `deterministic: true`,
  `kind: intervention` or `kind: outcome`, and `values`.
- `correlated`: pairs of variables that share an unmodelled common cause.
- `contexts`: named settings in which some variables are `fixed` and some
  edges are `inactive_edges`. The viewer answers queries within a context.

Any group or variable may carry a `data` mapping. `causalweb` validates that
it is a mapping and otherwise leaves it alone, so other tools can keep their
own information in the same file. Every other unknown key is reported as a
problem.

## Sphinx

    extensions = ["causalweb.sphinx_ext"]

    .. causal-graph:: path/to/graph.yaml
       :collapse: 1

    .. causal-graph-table:: some_group
       :file: path/to/graph.yaml

`causal-graph` embeds the viewer. `causal-graph-table` lists a group's
variables with their inputs, outputs and documentation. The documentation
column reads `data.documentation_ref` from each variable, a key that only this
extension knows about. The extension adds its assets to `html_static_path`
itself.

## Tests

    pip install -e ".[test]"
    playwright install chromium
    python -m unittest discover -s tests

The browser tests skip themselves when Chromium cannot start. Two tests use
the MNCNH graph from the `vivarium_research` repository. They look for a
checkout beside this one, or at the path in `CAUSALWEB_MNCNH`, and skip
when it is absent.

## License

MIT. See [LICENSE](LICENSE).
