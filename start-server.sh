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

# Bind Jekyll to 0.0.0.0 so it is exposed to the local network
if [ -f Gemfile ]; then
  JEKYLL_CMD=(bundle exec jekyll serve --livereload --host 0.0.0.0)
else
  JEKYLL_CMD=(jekyll serve --livereload --host 0.0.0.0)
fi

echo "Starting Jekyll (wedger)          -> http://0.0.0.0:4000"
"${JEKYLL_CMD[@]}" &
JEKYLL_PID=$!

# Bind live-server to 0.0.0.0 so it is exposed to the local network
echo "Starting file server (hledger-lib-wasm) -> http://0.0.0.0:$WASM_PORT"
npx --yes live-server "$WASM_DIR" --port="$WASM_PORT" --cors --no-browser --host=0.0.0.0 &
WASM_PID=$!

wait