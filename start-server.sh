#!/usr/bin/env bash
set -m   # enable job control so each background job gets its own process group,
         # which lets us kill each one's whole subtree cleanly on exit

WASM_DIR="../hledger-lib-wasm"
WASM_PORT=5001

cleanup() {
  echo -e "\nStopping dev servers..."
  [[ -n "${JEKYLL_PID:-}" ]]  && kill -- -"$JEKYLL_PID"  2>/dev/null
  [[ -n "${WASM_PID:-}" ]]    && kill -- -"$WASM_PID"    2>/dev/null
  wait 2>/dev/null
  exit 0
}
trap cleanup INT TERM

# Use bundler if this Jekyll project has a Gemfile, otherwise call jekyll directly
if [ -f Gemfile ]; then
  JEKYLL_CMD=(bundle exec jekyll serve --livereload)
else
  JEKYLL_CMD=(jekyll serve --livereload)
fi

echo "Starting Jekyll (wedger)          -> http://localhost:4000"
"${JEKYLL_CMD[@]}" &
JEKYLL_PID=$!

echo "Starting file server (hledger-lib-wasm) -> http://localhost:$WASM_PORT"
npx --yes live-server "$WASM_DIR" --port="$WASM_PORT" --cors --no-browser &
WASM_PID=$!

wait