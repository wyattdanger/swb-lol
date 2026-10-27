#!/bin/sh
# Runs every spec: the Python pipeline specs and the Node viewer specs. No Arena, network, or browser needed.
set -e
cd "$(dirname "$0")/.."
python3 -m unittest discover -s tests
node --test tests/*.test.js
