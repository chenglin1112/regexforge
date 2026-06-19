#!/usr/bin/env bash
# Package the regex-forge Executa as a standalone --onefile binary for Anna's
# "Binary" distribution. Produces:
#   dist/<tool_id>-<os>-<arch>.tar.gz   containing   bin/<tool_id> + manifest.json
# Run on each target platform (locally for macOS arm64; via CI for the rest).
set -euo pipefail

TOOL_ID="tool-chrisyang-0316-regex-forge-6svs9vut"
ENTRY_FILE="regex_forge_plugin.py"

OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
case "$OS" in
  darwin) OSLABEL="darwin" ;;
  linux)  OSLABEL="linux"  ;;
  *)      OSLABEL="$OS"    ;;
esac
ARCH="$(uname -m)"
case "$ARCH" in
  arm64|aarch64) ARCHLABEL="arm64"  ;;
  x86_64|amd64)  ARCHLABEL="x86_64" ;;
  *)             ARCHLABEL="$ARCH"  ;;
esac
PLATFORM="${OSLABEL}-${ARCHLABEL}"

echo "▶ building $TOOL_ID for $PLATFORM"
rm -rf build dist "${TOOL_ID}.spec"

# uv fetches an isolated Python + PyInstaller; the engine is stdlib-only.
uv run --no-project --with pyinstaller \
  python -m PyInstaller --onefile --name "$TOOL_ID" "$ENTRY_FILE"

# Assemble the archive layout the Anna runtime expects: bin/<tool_id> + manifest.json
STAGE="dist/stage"
rm -rf "$STAGE"
mkdir -p "$STAGE/bin"
cp "dist/$TOOL_ID" "$STAGE/bin/$TOOL_ID"
chmod +x "$STAGE/bin/$TOOL_ID"

cat > "$STAGE/manifest.json" <<JSON
{
  "runtime": {
    "binary": {
      "entrypoint": {
        "default": "bin/$TOOL_ID"
      }
    }
  }
}
JSON

TARBALL="dist/${TOOL_ID}-${PLATFORM}.tar.gz"
tar -C "$STAGE" -czf "$TARBALL" bin manifest.json
echo "✓ $TARBALL"
ls -lh "$TARBALL"
