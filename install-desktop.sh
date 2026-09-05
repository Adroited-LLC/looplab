#!/bin/bash
# Registers LoopLab AppImage with the desktop so the file manager shows
# the correct icon and it appears in the app launcher.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APPIMAGE="${1:-$HOME/Apps/LoopLab-x86_64.AppImage}"
ICON_SRC="$SCRIPT_DIR/src-tauri/icons/icon.png"

if [ ! -f "$APPIMAGE" ]; then
    echo "Error: AppImage not found at $APPIMAGE"
    echo "Usage: $0 [path/to/AppImage]"
    exit 1
fi

APPIMAGE="$(realpath "$APPIMAGE")"

# ── Install icon at multiple sizes ─────────────────────────────────────────
echo "Installing icons..."
for size in 128 256 512; do
    ICON_DIR="$HOME/.local/share/icons/hicolor/${size}x${size}/apps"
    mkdir -p "$ICON_DIR"
    if command -v magick &>/dev/null; then
        magick "$ICON_SRC" -resize "${size}x${size}" "$ICON_DIR/looplab.png"
    elif command -v convert &>/dev/null; then
        convert "$ICON_SRC" -resize "${size}x${size}" "$ICON_DIR/looplab.png"
    else
        cp "$ICON_SRC" "$ICON_DIR/looplab.png"
    fi
    echo "  Installed ${size}x${size} icon"
done

# ── Install .desktop file ──────────────────────────────────────────────────
APPS_DIR="$HOME/.local/share/applications"
mkdir -p "$APPS_DIR"

cat > "$APPS_DIR/looplab.desktop" <<EOF
[Desktop Entry]
Name=LoopLab
Comment=Guitar practice — pitch, speed, loops, metronome
Exec=$APPIMAGE %f
Icon=looplab
Type=Application
Categories=AudioVideo;Audio;Music;
StartupWMClass=looplab
MimeType=audio/mpeg;audio/wav;audio/ogg;audio/flac;audio/x-flac;audio/mp4;audio/aac;
Terminal=false
EOF

echo "  Installed looplab.desktop -> $APPS_DIR/looplab.desktop"

# ── Refresh caches ─────────────────────────────────────────────────────────
gtk-update-icon-cache -f -t "$HOME/.local/share/icons/hicolor" 2>/dev/null && \
    echo "  Updated icon cache" || true
update-desktop-database "$APPS_DIR" 2>/dev/null && \
    echo "  Updated desktop database" || true

echo ""
echo "Done! LoopLab is now registered with your desktop."
echo "You may need to refresh Nautilus (Ctrl+R or reopen) to see the icon."
