#!/bin/sh
# Re-exports the PNG icons from the SVG sources with headless Chrome.
#   penny.svg        → icon-32.png, icon-48.png, icon-128.png
#   penny-small.svg  → icon-16.png (simplified for the toolbar)
# Usage (from anywhere):  sh extension/icons/export-icons.sh
set -e
cd "$(dirname "$0")"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
PROFILE="$(mktemp -d)"

render() { # render <svg> <size> <output png>
  # Copy the SVG with width/height set to the target size (its viewBox does
  # the scaling), then screenshot a window of exactly that size.
  sed -E "s/ width=\"[0-9]+\" height=\"[0-9]+\"/ width=\"$2\" height=\"$2\"/" "$1" > "$PROFILE/icon.svg"
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars \
    --user-data-dir="$PROFILE/chrome" --default-background-color=00000000 \
    --window-size="$2,$2" --screenshot="$PWD/$3" "file://$PROFILE/icon.svg" >/dev/null 2>&1
}

render penny-small.svg 16 icon-16.png
render penny.svg 32 icon-32.png
render penny.svg 48 icon-48.png
render penny.svg 128 icon-128.png
rm -rf "$PROFILE"
echo "Exported icon-16/32/48/128.png"
