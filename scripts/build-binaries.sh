#!/usr/bin/env bash
#
# Build prime-agent binaries for all platforms locally.
# Mirrors .github/workflows/build-binaries.yml
#
# Usage:
#   ./scripts/build-binaries.sh [--skip-deps] [--platform <platform>]
#
# Options:
#   --skip-deps         Skip installing cross-platform dependencies
#   --platform <name>   Build only for specified platform (darwin-arm64, darwin-x64, linux-x64, linux-arm64, windows-x64)
#
# Output:
#   packages/coding-agent/binaries/
#     prime-agent-darwin-arm64.tar.gz
#     prime-agent-darwin-x64.tar.gz
#     prime-agent-linux-x64.tar.gz
#     prime-agent-linux-arm64.tar.gz
#     prime-agent-windows-x64.zip

set -euo pipefail

cd "$(dirname "$0")/.."

SKIP_DEPS=false
PLATFORM=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --skip-deps)
            SKIP_DEPS=true
            shift
            ;;
        --platform)
            PLATFORM="$2"
            shift 2
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

# Validate platform if specified
if [[ -n "$PLATFORM" ]]; then
    case "$PLATFORM" in
        darwin-arm64|darwin-x64|linux-x64|linux-arm64|windows-x64)
            ;;
        *)
            echo "Invalid platform: $PLATFORM"
            echo "Valid platforms: darwin-arm64, darwin-x64, linux-x64, linux-arm64, windows-x64"
            exit 1
            ;;
    esac
fi

echo "==> Installing dependencies..."
npm ci

if [[ "$SKIP_DEPS" == "false" ]]; then
    echo "==> Installing cross-platform native bindings..."
    # npm ci only installs optional deps for the current platform
    # We need all platform bindings for bun cross-compilation
    # Use --force to bypass platform checks (os/cpu restrictions in package.json)
    # Install all in one command to avoid npm removing packages from previous installs
    npm install --no-save --force \
        @mariozechner/clipboard-darwin-arm64@0.3.0 \
        @mariozechner/clipboard-darwin-x64@0.3.0 \
        @mariozechner/clipboard-linux-x64-gnu@0.3.0 \
        @mariozechner/clipboard-linux-arm64-gnu@0.3.0 \
        @mariozechner/clipboard-win32-x64-msvc@0.3.0 \
        @img/sharp-darwin-arm64@0.34.5 \
        @img/sharp-darwin-x64@0.34.5 \
        @img/sharp-linux-x64@0.34.5 \
        @img/sharp-linux-arm64@0.34.5 \
        @img/sharp-win32-x64@0.34.5 \
        @img/sharp-libvips-darwin-arm64@1.2.4 \
        @img/sharp-libvips-darwin-x64@1.2.4 \
        @img/sharp-libvips-linux-x64@1.2.4 \
        @img/sharp-libvips-linux-arm64@1.2.4
else
    echo "==> Skipping cross-platform native bindings (--skip-deps)"
fi

echo "==> Building all packages..."
npm run build

echo "==> Building binaries..."
cd packages/coding-agent

# Clean previous builds
rm -rf binaries
mkdir -p binaries/{darwin-arm64,darwin-x64,linux-x64,linux-arm64,windows-x64}

# Determine which platforms to build
if [[ -n "$PLATFORM" ]]; then
    PLATFORMS=("$PLATFORM")
else
    PLATFORMS=(darwin-arm64 darwin-x64 linux-x64 linux-arm64 windows-x64)
fi

for platform in "${PLATFORMS[@]}"; do
    echo "Building for $platform..."
    # Externalize native modules so their .node files are loaded from the
    # release directory instead of embedding build-machine paths into the
    # compiled Bun executable.
    if [[ "$platform" == "windows-x64" ]]; then
        bun build --compile --external koffi --external zeromq --target=bun-$platform ./dist/bun/cli.js --outfile binaries/$platform/prime-agent-bin.exe
    else
        bun build --compile --external koffi --external zeromq --target=bun-$platform ./dist/bun/cli.js --outfile binaries/$platform/prime-agent-bin
    fi
done

echo "==> Creating release archives..."

create_launcher() {
    local platform="$1"
    local target_dir="$2"

    if [[ "$platform" == "windows-x64" ]]; then
        cat > "$target_dir/prime-agent.cmd" <<'EOF'
@echo off
setlocal
cd /d "%~dp0"
set "NODE_PATH=%~dp0node_modules;%NODE_PATH%"
"%~dp0prime-agent-bin.exe" %*
EOF
    else
        cat > "$target_dir/prime-agent" <<'EOF'
#!/bin/sh
set -eu

script="$0"
while [ -L "$script" ]; do
    dir="$(CDPATH= cd "$(dirname "$script")" && pwd)"
    target="$(readlink "$script")"
    case "$target" in
        /*) script="$target" ;;
        *) script="$dir/$target" ;;
    esac
done

dir="$(CDPATH= cd "$(dirname "$script")" && pwd)"
cd "$dir"
export NODE_PATH="$dir/node_modules${NODE_PATH:+:$NODE_PATH}"
exec "$dir/prime-agent-bin" "$@"
EOF
        chmod +x "$target_dir/prime-agent"
    fi
}

copy_zeromq_runtime() {
    local platform="$1"
    local target_dir="$2"
    local modules_dir="$target_dir/node_modules"

    mkdir -p "$modules_dir/zeromq/lib"
    mkdir -p "$modules_dir/zeromq/build"
    mkdir -p "$modules_dir/cmake-ts/build"

    cp ../../node_modules/zeromq/package.json "$modules_dir/zeromq/"
    cp -R ../../node_modules/zeromq/lib/. "$modules_dir/zeromq/lib/"
    cp ../../node_modules/zeromq/build/manifest.json "$modules_dir/zeromq/build/"

    case "$platform" in
        darwin-arm64)
            mkdir -p "$modules_dir/zeromq/build/darwin"
            cp -R ../../node_modules/zeromq/build/darwin/arm64 "$modules_dir/zeromq/build/darwin/"
            ;;
        darwin-x64)
            mkdir -p "$modules_dir/zeromq/build/darwin"
            cp -R ../../node_modules/zeromq/build/darwin/x64 "$modules_dir/zeromq/build/darwin/"
            ;;
        linux-arm64)
            mkdir -p "$modules_dir/zeromq/build/linux"
            cp -R ../../node_modules/zeromq/build/linux/arm64 "$modules_dir/zeromq/build/linux/"
            ;;
        linux-x64)
            mkdir -p "$modules_dir/zeromq/build/linux"
            cp -R ../../node_modules/zeromq/build/linux/x64 "$modules_dir/zeromq/build/linux/"
            ;;
        windows-x64)
            mkdir -p "$modules_dir/zeromq/build/win32"
            cp -R ../../node_modules/zeromq/build/win32/x64 "$modules_dir/zeromq/build/win32/"
            ;;
    esac

    cp ../../node_modules/cmake-ts/package.json "$modules_dir/cmake-ts/"
    cp ../../node_modules/cmake-ts/build/loader.js "$modules_dir/cmake-ts/build/"
}

# Copy shared files to each platform directory
for platform in "${PLATFORMS[@]}"; do
    cp package.json binaries/$platform/
    cp README.md binaries/$platform/
    cp CHANGELOG.md binaries/$platform/
    cp ../../node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm binaries/$platform/
    mkdir -p binaries/$platform/theme
    cp dist/modes/interactive/theme/*.json binaries/$platform/theme/
    mkdir -p binaries/$platform/assets
    cp dist/modes/interactive/assets/* binaries/$platform/assets/
    cp -r dist/core/export-html binaries/$platform/
    cp -r docs binaries/$platform/
    cp -r examples binaries/$platform/
    cp -r dist/prime-agent-runtime binaries/$platform/
    create_launcher "$platform" "binaries/$platform"
    copy_zeromq_runtime "$platform" "binaries/$platform"

    # Copy koffi native module for Windows (needed for VT input support)
    if [[ "$platform" == "windows-x64" ]]; then
        mkdir -p binaries/$platform/node_modules/koffi/build/koffi/win32_x64
        cp ../../node_modules/koffi/index.js binaries/$platform/node_modules/koffi/
        cp ../../node_modules/koffi/package.json binaries/$platform/node_modules/koffi/
        cp ../../node_modules/koffi/build/koffi/win32_x64/koffi.node binaries/$platform/node_modules/koffi/build/koffi/win32_x64/
    fi
done

# Create archives
cd binaries

for platform in "${PLATFORMS[@]}"; do
    if [[ "$platform" == "windows-x64" ]]; then
        # Windows (zip)
        echo "Creating prime-agent-$platform.zip..."
        mv $platform prime-agent && zip -r prime-agent-$platform.zip prime-agent && mv prime-agent $platform
    else
        # Unix platforms (tar.gz) - use wrapper directory for mise compatibility
        echo "Creating prime-agent-$platform.tar.gz..."
        mv $platform prime-agent && tar -czf prime-agent-$platform.tar.gz prime-agent && mv prime-agent $platform
    fi
done

# Extract archives for easy local testing
echo "==> Extracting archives for testing..."
for platform in "${PLATFORMS[@]}"; do
    rm -rf $platform
    if [[ "$platform" == "windows-x64" ]]; then
        unzip -q prime-agent-$platform.zip && mv prime-agent $platform
    else
        tar -xzf prime-agent-$platform.tar.gz && mv prime-agent $platform
    fi
done

echo ""
echo "==> Build complete!"
echo "Archives available in packages/coding-agent/binaries/"
ls -lh *.tar.gz *.zip 2>/dev/null || true
echo ""
echo "Extracted directories for testing:"
for platform in "${PLATFORMS[@]}"; do
    echo "  binaries/$platform/prime-agent"
done
