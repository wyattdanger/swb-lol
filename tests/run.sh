#!/bin/sh
# Runs every spec with Node's built-in test runner. No Arena install, network, browser, or npm install needed.
# The flags let older Node versions load the built-in SQLite module, silence its experimental-feature warning,
# and let one spec force garbage collection.
set -e
cd "$(dirname "$0")/.."
exec node --experimental-sqlite --disable-warning=ExperimentalWarning --expose-gc --test tests/*.test.mjs
