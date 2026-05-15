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

echo "==> Building standalone Node distributions..."
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

NODE_STANDALONE_VERSION="${NODE_STANDALONE_VERSION:-22.14.0}"
NODE_RUNTIME_MODULES="binaries/node-runtime"

copy_workspace_package() {
    local source_dir="$1"
    local target_dir="$2"

    mkdir -p "$target_dir"
    cp "$source_dir/package.json" "$target_dir/"
    if [[ -f "$source_dir/README.md" ]]; then
        cp "$source_dir/README.md" "$target_dir/"
    fi
    if [[ -f "$source_dir/CHANGELOG.md" ]]; then
        cp "$source_dir/CHANGELOG.md" "$target_dir/"
    fi
    cp -R "$source_dir/dist" "$target_dir/"
}

prepare_node_runtime_modules() {
    echo "==> Installing standalone runtime node_modules..."
    rm -rf "$NODE_RUNTIME_MODULES"
    mkdir -p "$NODE_RUNTIME_MODULES"

    STAGING_PACKAGE_JSON="$NODE_RUNTIME_MODULES/package.json" node <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const out = process.env.STAGING_PACKAGE_JSON;
const packagePaths = [
	"../agent/package.json",
	"../ai/package.json",
	"../tui/package.json",
	"package.json",
];

const dependencies = {};
const optionalDependencies = {};

function merge(target, values) {
	for (const [name, version] of Object.entries(values ?? {})) {
		if (name.startsWith("@earendil-works/pi-")) continue;
		target[name] = version;
	}
}

for (const packagePath of packagePaths) {
	const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
	merge(dependencies, pkg.dependencies);
	merge(optionalDependencies, pkg.optionalDependencies);
}

fs.writeFileSync(
	out,
	`${JSON.stringify(
		{
			private: true,
			type: "module",
			dependencies,
			optionalDependencies,
		},
		null,
		2,
	)}\n`,
);
NODE

    npm install --prefix "$NODE_RUNTIME_MODULES" --omit=dev --no-audit --no-fund

    mkdir -p "$NODE_RUNTIME_MODULES/node_modules/@earendil-works"
    copy_workspace_package "../agent" "$NODE_RUNTIME_MODULES/node_modules/@earendil-works/pi-agent-core"
    copy_workspace_package "../ai" "$NODE_RUNTIME_MODULES/node_modules/@earendil-works/pi-ai"
    copy_workspace_package "../tui" "$NODE_RUNTIME_MODULES/node_modules/@earendil-works/pi-tui"
    copy_workspace_package "." "$NODE_RUNTIME_MODULES/node_modules/@earendil-works/pi-coding-agent"
}

download_node_runtime() {
    local platform="$1"
    local target_dir="$2"
    local version="v$NODE_STANDALONE_VERSION"
    local base_url="https://nodejs.org/dist/$version"
    local tmp_dir="binaries/node-download-$platform"
    local archive=""
    local extracted=""

    rm -rf "$tmp_dir"
    mkdir -p "$tmp_dir"

    case "$platform" in
        darwin-arm64|darwin-x64|linux-x64|linux-arm64)
            archive="node-$version-$platform"
            if [[ "$platform" == linux-* ]]; then
                archive="$archive.tar.xz"
                curl -fsSL "$base_url/$archive" -o "$tmp_dir/$archive"
                tar -xJf "$tmp_dir/$archive" -C "$tmp_dir"
            else
                archive="$archive.tar.gz"
                curl -fsSL "$base_url/$archive" -o "$tmp_dir/$archive"
                tar -xzf "$tmp_dir/$archive" -C "$tmp_dir"
            fi
            extracted="${archive%.tar.gz}"
            extracted="${extracted%.tar.xz}"
            mkdir -p "$target_dir/node/bin"
            cp "$tmp_dir/$extracted/bin/node" "$target_dir/node/bin/node"
            chmod +x "$target_dir/node/bin/node"
            ;;
        windows-x64)
            archive="node-$version-win-x64.zip"
            curl -fsSL "$base_url/$archive" -o "$tmp_dir/$archive"
            unzip -q "$tmp_dir/$archive" -d "$tmp_dir"
            extracted="${archive%.zip}"
            mkdir -p "$target_dir/node"
            cp "$tmp_dir/$extracted/node.exe" "$target_dir/node/node.exe"
            ;;
    esac

    rm -rf "$tmp_dir"
}

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
set "PI_PACKAGE_DIR=%~dp0"
"%~dp0node\node.exe" "%~dp0dist\cli.js" %*
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
export PI_PACKAGE_DIR="$dir"
exec "$dir/node/bin/node" "$dir/dist/cli.js" "$@"
EOF
        chmod +x "$target_dir/prime-agent"
    fi
}

prepare_node_runtime_modules

# Copy shared files to each platform directory
for platform in "${PLATFORMS[@]}"; do
    cp package.json binaries/$platform/
    cp README.md binaries/$platform/
    cp CHANGELOG.md binaries/$platform/
    cp -R dist binaries/$platform/
    cp -R "$NODE_RUNTIME_MODULES/node_modules" binaries/$platform/
    download_node_runtime "$platform" "binaries/$platform"
    mkdir -p binaries/$platform/theme
    cp dist/modes/interactive/theme/*.json binaries/$platform/theme/
    mkdir -p binaries/$platform/assets
    cp dist/modes/interactive/assets/* binaries/$platform/assets/
    cp -r dist/core/export-html binaries/$platform/
    cp -r docs binaries/$platform/
    cp -r examples binaries/$platform/
    cp -r dist/prime-agent-runtime binaries/$platform/
    create_launcher "$platform" "binaries/$platform"
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
