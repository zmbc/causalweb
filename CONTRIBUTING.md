# Contributing

## Set up a conda environment

Create the environment and install `causalweb` in editable mode, with the
test and Sphinx extras:

    conda create -n causalweb -c conda-forge python=3.13 pip
    conda activate causalweb
    pip install -e ".[test,sphinx]"

The browser tests drive the viewer in headless Chromium through Playwright.
Chromium needs some system libraries and a fontconfig configuration. On a
machine that does not have them, and where you cannot install system
packages, install them from conda-forge:

    conda install -n causalweb -c conda-forge \
        nspr nss atk-1.0 at-spi2-atk libxkbcommon \
        xorg-libxcomposite xorg-libxdamage xorg-libxfixes xorg-libxrandr \
        mesalib fontconfig fonts-conda-ecosystem fonts-conda-forge

Playwright 1.64.1 refuses to install Chromium on Ubuntu 20.04. Playwright
1.62.0 works there. On Ubuntu 20.04, pin it first:

    pip install "playwright==1.62.0"

Then download the Chromium build that Playwright uses:

    playwright install chromium

## Run the tests

    pytest

If you installed the libraries from conda-forge, point Chromium at them:

    LD_LIBRARY_PATH="$CONDA_PREFIX/lib" \
    FONTCONFIG_FILE="$CONDA_PREFIX/etc/fonts/fonts.conf" \
        pytest

Without `FONTCONFIG_FILE`, Chromium can abort in its font code. The browser
tests then fail with `TargetClosedError`.

The tests are in four files:

- `tests/test_model.py` tests loading, validation and the JSON for the viewer.
- `tests/test_server.py` tests the live-reloading server over HTTP.
- `tests/test_sphinx_ext.py` tests the Sphinx extension. It checks its keys in
  `data` and builds a small Sphinx project with both directives.
  It skips itself when Sphinx is not installed.
- `tests/test_ui.py` tests the viewer in headless Chromium. These tests skip
  themselves when Playwright is not installed or Chromium cannot start.

The adjacency matrix and all the causal queries are JavaScript, so only the
browser tests cover them. The browser tests also load
`causalweb/static/causalweb_adjustment.js`, which no page loads.

`tests/nested.yaml` is a small two-level graph. Its file order disagrees with
its causal order at every level. The browser tests check the order of its
adjacency matrix at every level.
