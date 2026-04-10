#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

EDITOR_COMMAND="${EDITOR_COMMAND:-code}"
AUTO_YES="${AUTO_YES:-1}"

if [[ "${1:-}" == "--editor" ]]; then
	EDITOR_COMMAND="${2:-code}"
	shift 2
fi

VSIX_PATH="$(node -e 'const pkg=require("./src/package.json"); process.stdout.write(`./bin/${pkg.name}-${pkg.version}.vsix`)')"
BUILD_STARTED_AT="$(date +%s)"

echo "Running typecheck preflight..."
pnpm --dir src run check-types

echo "Building webview preflight..."
pnpm --dir webview-ui build

echo "Building VSIX sequentially..."
pnpm vsix

if [[ ! -f "$VSIX_PATH" ]]; then
	echo "VSIX not found after build: $VSIX_PATH" >&2
	exit 1
fi

VSIX_MTIME="$(stat -f %m "$VSIX_PATH")"
if (( VSIX_MTIME < BUILD_STARTED_AT )); then
	echo "VSIX artifact was not refreshed by the build: $VSIX_PATH" >&2
	exit 1
fi

echo "Installing freshly built VSIX sequentially..."
if [[ "$AUTO_YES" == "1" ]]; then
	node ./scripts/install-vsix.js --editor="$EDITOR_COMMAND" -y "$@"
else
	node ./scripts/install-vsix.js --editor="$EDITOR_COMMAND" "$@"
fi
