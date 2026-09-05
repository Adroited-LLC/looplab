#!/bin/bash
# Patches a Tauri-built AppImage to include WebKit2GTK helper processes and
# the injected bundle library, which linuxdeploy omits. Also makes AppRun
# cd to $APPDIR so WebKit resolves relative helper paths correctly.

set -e

APPIMAGE_PATH="${1:-$(ls src-tauri/target/release/bundle/appimage/LoopLab*.AppImage 2>/dev/null | grep -v appimagetool | head -1)}"
WEBKIT_EXEC_DIR="/usr/libexec/webkit2gtk-4.1"
WEBKIT_LIB_DIR="/usr/lib64/webkit2gtk-4.1"
ARCH="${ARCH:-x86_64}"

# Project root (directory containing this script)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ICON_512="$SCRIPT_DIR/src-tauri/icons/icon.png"

if [ ! -f "$APPIMAGE_PATH" ]; then
    echo "Error: AppImage not found at $APPIMAGE_PATH"
    echo "Usage: $0 [path/to/AppImage]"
    exit 1
fi

APPIMAGE_PATH="$(realpath "$APPIMAGE_PATH")"
OUTDIR="$(dirname "$APPIMAGE_PATH")"

# Download appimagetool if not present
APPIMAGETOOL="${APPIMAGETOOL:-$(command -v appimagetool 2>/dev/null || true)}"
if [ -z "$APPIMAGETOOL" ]; then
    APPIMAGETOOL="$OUTDIR/appimagetool-x86_64.AppImage"
    if [ ! -f "$APPIMAGETOOL" ]; then
        echo "Downloading appimagetool..."
        curl -Lo "$APPIMAGETOOL" \
            "https://github.com/AppImage/AppImageKit/releases/download/continuous/appimagetool-x86_64.AppImage"
        chmod +x "$APPIMAGETOOL"
    fi
fi

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

echo "Extracting AppImage..."
cd "$WORKDIR"
"$APPIMAGE_PATH" --appimage-extract > /dev/null

ROOT="$WORKDIR/squashfs-root"

# ── 1. WebKit helper executables at AppDir root-relative libexec/ ──────────
# WebKit2GTK resolves helper paths relative to CWD (the AppDir), so they
# must live at $APPDIR/libexec/webkit2gtk-4.1/ (not usr/libexec/).
HELPER_DEST="$ROOT/libexec/webkit2gtk-4.1"
mkdir -p "$HELPER_DEST"

BUNDLED=0
for binary in WebKitNetworkProcess WebKitWebProcess WebKitGPUProcess; do
    src="$WEBKIT_EXEC_DIR/$binary"
    if [ -f "$src" ]; then
        cp "$src" "$HELPER_DEST/"
        chmod +x "$HELPER_DEST/$binary"
        echo "  Bundled helper: $binary"
        BUNDLED=$((BUNDLED + 1))
    else
        echo "  WARNING: $src not found, skipping"
    fi
done

if [ "$BUNDLED" -eq 0 ]; then
    echo "Error: No WebKit helpers found in $WEBKIT_EXEC_DIR"
    exit 1
fi

# ── 2. WebKit injected bundle at AppDir root-relative lib64/ ───────────────
BUNDLE_SRC="$WEBKIT_LIB_DIR/injected-bundle/libwebkit2gtkinjectedbundle.so"
BUNDLE_DEST="$ROOT/lib64/webkit2gtk-4.1/injected-bundle"
if [ -f "$BUNDLE_SRC" ]; then
    mkdir -p "$BUNDLE_DEST"
    cp "$BUNDLE_SRC" "$BUNDLE_DEST/"
    echo "  Bundled: libwebkit2gtkinjectedbundle.so"
else
    echo "  WARNING: injected bundle not found at $BUNDLE_SRC"
fi

# ── 3. Replace icons with full 512×512 source icon ────────────────────────
# Tauri embeds a 128×128 PNG; file managers need high-res icons to display
# the app icon correctly on the AppImage file itself.
if [ -f "$ICON_512" ]; then
    # Root-level icon (.DirIcon symlink already points to looplab.png)
    cp "$ICON_512" "$ROOT/looplab.png"

    # hicolor icon tree — create proper-sized copies
    for size in 128 256 512; do
        ICON_DIR="$ROOT/usr/share/icons/hicolor/${size}x${size}/apps"
        mkdir -p "$ICON_DIR"
        if command -v magick &>/dev/null; then
            magick "$ICON_512" -resize "${size}x${size}" "$ICON_DIR/looplab.png"
        elif command -v convert &>/dev/null; then
            convert "$ICON_512" -resize "${size}x${size}" "$ICON_DIR/looplab.png"
        else
            cp "$ICON_512" "$ICON_DIR/looplab.png"
        fi
    done
    echo "  Updated icons from $ICON_512"
else
    echo "  WARNING: $ICON_512 not found, icons not updated"
fi

# ── 4. Patch AppRun to cd to \$APPDIR before exec ─────────────────────────
# This is essential: WebKit constructs paths like ./libexec/... (relative to CWD).
APPRUN="$ROOT/AppRun"
if ! grep -q 'cd "\$this_dir"' "$APPRUN" 2>/dev/null; then
    # Insert 'cd "$this_dir"' before the final exec line.
    # The line to match is: exec "$this_dir"/AppRun.wrapped "$@"
    sed -i 's|^exec "\$this_dir"/AppRun\.wrapped|cd "$this_dir"\nexec "$this_dir"/AppRun.wrapped|' "$APPRUN"
    echo "  Patched AppRun: added cd to AppDir"
fi

# ── 4b. Wrap the main binary to fix GStreamer plugin paths ────────────────
# AppRun.wrapped (compiled C) sets GST_PLUGIN_SYSTEM_PATH(_1_0) to
# $APPDIR/usr/lib/gstreamer(-1.0) which is empty — overriding GStreamer's
# default search path so no plugins are found. We can't unset these before
# AppRun.wrapped because it re-sets them. Instead, wrap the real binary so
# the unset happens AFTER AppRun.wrapped but BEFORE the app (and its
# WebKit child processes) start.
REAL_BIN="$ROOT/usr/bin/looplab"
if [ -f "$REAL_BIN" ] && [ ! -f "$REAL_BIN.real" ]; then
    mv "$REAL_BIN" "$REAL_BIN.real"
    cat > "$REAL_BIN" <<'WRAPPER'
#!/bin/bash
unset GST_PLUGIN_SYSTEM_PATH GST_PLUGIN_SYSTEM_PATH_1_0 GST_PLUGIN_PATH GST_PLUGIN_PATH_1_0
exec "$(dirname "$0")/looplab.real" "$@"
WRAPPER
    chmod +x "$REAL_BIN"
    echo "  Wrapped looplab binary: unset GStreamer plugin path overrides"
fi

# ── 5. Remove bundled libpulse so system version is used ──────────────────
# The bundled libpulse may fail to connect to PipeWire's PulseAudio socket.
# Removing it forces the app to use the system libpulse (which is already
# wired up to PipeWire correctly).
for f in libpulse.so.0 libpulse-simple.so.0 libpulsecommon-17.0.so; do
    if [ -f "$ROOT/usr/lib/$f" ]; then
        rm -f "$ROOT/usr/lib/$f"
        echo "  Removed bundled $f (using system version)"
    fi
done

# ── 5b. Remove bundled GStreamer core libs so system versions are used ────
# The AppImage bundles GStreamer core libraries but NOT GStreamer plugins
# (audio sinks, decoders, etc.). This causes "failed to start audio device"
# because GStreamer can't find any output plugin. Removing the bundled core
# forces both the app and WebKit helpers to use the system GStreamer (core +
# plugins) consistently.
for f in "$ROOT"/usr/lib/libgst*.so.*; do
    [ -f "$f" ] || continue
    rm -f "$f"
    echo "  Removed bundled $(basename "$f") (using system version)"
done

# ── 6. Repack ──────────────────────────────────────────────────────────────
OUTPUT_PATH="$OUTDIR/LoopLab-x86_64.AppImage"   # canonical name regardless of source filename
echo "Repacking AppImage -> $OUTPUT_PATH"
ARCH="$ARCH" "$APPIMAGETOOL" "$ROOT/" "$OUTPUT_PATH" 2>&1

echo ""
echo "Done! Patched AppImage: $OUTPUT_PATH"
