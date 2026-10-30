#!/bin/zsh
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
export PATH="$HOME/.bun/bin:/opt/homebrew/bin:/opt/homebrew/opt/node@22/bin:/usr/local/bin:$PATH"

# The host passes its own bundled runtime as VOICEOS_BUN (vendoredRuntime.ts),
# so integrations start on machines with no bun or node installed at all.
# Machine installs are only fallbacks for hosts that predate the vendored
# runtime — or for developers pointing the folder at their own toolchain.
BUN=""
if [[ -n "${VOICEOS_BUN:-}" && -x "${VOICEOS_BUN}" ]]; then
  BUN="$VOICEOS_BUN"
fi
if [[ -z "$BUN" ]]; then
  for candidate in "$HOME/.bun/bin/bun" /opt/homebrew/bin/bun "$(command -v bun 2>/dev/null || true)"; do
    if [[ -n "$candidate" && -x "$candidate" ]]; then BUN="$candidate"; break; fi
  done
fi

if [[ ! -d "$SCRIPT_DIR/node_modules" ]]; then
  if [[ -n "$BUN" ]]; then
    (cd "$SCRIPT_DIR" && "$BUN" install) >&2 || (cd "$SCRIPT_DIR" && npm install) >&2
  else
    (cd "$SCRIPT_DIR" && npm install) >&2
  fi
fi

# Bun executes TypeScript natively — the fast path.
if [[ -n "$BUN" ]]; then
  exec "$BUN" "$SCRIPT_DIR/server.ts" "$@"
fi

# Node path: tsx is a declared dependency, so it's local after install.
if [[ -x "$SCRIPT_DIR/node_modules/.bin/tsx" ]]; then
  exec "$SCRIPT_DIR/node_modules/.bin/tsx" "$SCRIPT_DIR/server.ts" "$@"
fi
exec npx --yes tsx "$SCRIPT_DIR/server.ts" "$@"
