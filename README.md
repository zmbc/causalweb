# causalweb

> [!CAUTION]
> This tool is an early prototype entirely implemented by AI.

A tool for authoring and exploring complex causal graphs.

Graphs are written in a plain-text YAML format
but can be viewed in real time, interactively, in a browser.
The viewer shows both a node-link diagram and an adjacency matrix.

To accommodate large graphs, the viewer supports summarization,
which can both be specified by the author (in the form of hierarchically nested groups)
and happen interactively through causal queries about the relationship between two variables.

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

`serve` listens on port 8765, or the next free port when that one is taken.
An explicit `--port` is strict. `--port 0` takes any free port.

## The YAML schema

The schema is documented in [causalweb/model.py](causalweb/model.py).
A file has these top-level keys:

- `nodes`: the variables, each with a `name`, a `label`, `caused_by` (the
  names of its direct causes), and optionally `deterministic: true` and
  `kind: intervention` or `kind: outcome`.
- `groups`: each with a `name`, a `label`, and `contains`, the names of the
  groups and variables inside it.
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
variables with their inputs, outputs and documentation. The table reads two
keys from `data` that only this extension knows about: `documentation_ref`,
the document specifying a group or variable, which it links to; and
`categories`, the categories of a categorical variable, which it lists after
the variable's label among the outputs. The extension adds its assets to
`html_static_path` itself.

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
