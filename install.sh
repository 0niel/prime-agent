#!/bin/sh

set -eu

repo="${PRIME_AGENT_REPO:-PrimeIntellect-ai/prime-agent}"
github_token="${GITHUB_TOKEN:-${GH_TOKEN:-}}"
bin_dir="${PRIME_AGENT_BIN_DIR:-"$HOME/.local/bin"}"
data_home="${XDG_DATA_HOME:-"$HOME/.local/share"}"
install_root="${PRIME_AGENT_INSTALL_DIR:-"$data_home/prime-agent"}"

need_cmd() {
	if ! command -v "$1" >/dev/null 2>&1; then
		echo "prime-agent installer: missing required command: $1" >&2
		exit 1
	fi
}

github_api() {
	if [ -n "$github_token" ]; then
		curl -fsSL \
			-H "Authorization: Bearer $github_token" \
			-H "Accept: application/vnd.github+json" \
			"$1"
	else
		curl -fsSL "$1"
	fi
}

download_file() {
	if [ -n "$github_token" ]; then
		curl -fL --progress-bar \
			-H "Authorization: Bearer $github_token" \
			-o "$2" \
			"$1"
	else
		curl -fL --progress-bar -o "$2" "$1"
	fi
}

detect_platform() {
	os="$(uname -s)"
	arch="$(uname -m)"

	case "$os" in
		Darwin)
			os="darwin"
			;;
		Linux)
			os="linux"
			;;
		*)
			echo "prime-agent installer: unsupported OS: $os" >&2
			echo "Download a release manually: https://github.com/$repo/releases/latest" >&2
			exit 1
			;;
	esac

	case "$arch" in
		arm64|aarch64)
			arch="arm64"
			;;
		x86_64|amd64)
			arch="x64"
			;;
		*)
			echo "prime-agent installer: unsupported CPU architecture: $arch" >&2
			echo "Download a release manually: https://github.com/$repo/releases/latest" >&2
			exit 1
			;;
	esac

	printf '%s-%s' "$os" "$arch"
}

fetch_latest_tag() {
	if [ -n "${PRIME_AGENT_VERSION:-}" ]; then
		case "$PRIME_AGENT_VERSION" in
			v*) printf '%s' "$PRIME_AGENT_VERSION" ;;
			*) printf 'v%s' "$PRIME_AGENT_VERSION" ;;
		esac
		return
	fi

	release_json="$(github_api "https://api.github.com/repos/$repo/releases/latest")"
	tag="$(printf '%s\n' "$release_json" | sed -n 's/.*"tag_name":[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
	if [ -z "$tag" ]; then
		echo "prime-agent installer: could not find latest release tag for $repo" >&2
		exit 1
	fi
	printf '%s' "$tag"
}

need_cmd curl
need_cmd head
need_cmd ln
need_cmd mktemp
need_cmd mkdir
need_cmd mv
need_cmd rm
need_cmd sed
need_cmd tar
need_cmd uname

platform="$(detect_platform)"
tag="$(fetch_latest_tag)"
version="${tag#v}"
asset="prime-agent-$platform.tar.gz"
url="https://github.com/$repo/releases/download/$tag/$asset"

tmp_dir="$(mktemp -d)"
cleanup() {
	rm -rf "$tmp_dir"
}
trap cleanup EXIT INT TERM

archive="$tmp_dir/$asset"

echo "Downloading prime-agent $tag for $platform..."
download_file "$url" "$archive"

tar -xzf "$archive" -C "$tmp_dir"

payload_dir="$tmp_dir/prime-agent"
executable="$payload_dir/prime-agent"
if [ ! -x "$executable" ]; then
	echo "prime-agent installer: archive did not contain executable prime-agent/prime-agent" >&2
	exit 1
fi

mkdir -p "$install_root" "$bin_dir"

version_dir="$install_root/$version"
staged_version_dir="$install_root/.$version.tmp.$$"
rm -rf "$staged_version_dir"
mv "$payload_dir" "$staged_version_dir"
rm -rf "$version_dir"
mv "$staged_version_dir" "$version_dir"

link="$bin_dir/prime-agent"
if [ -e "$link" ] && [ ! -L "$link" ]; then
	echo "prime-agent installer: $link already exists and is not a symlink" >&2
	echo "Move it aside and re-run this installer." >&2
	exit 1
fi

ln -sfn "$version_dir/prime-agent" "$link"

echo "Installed prime-agent $tag to $version_dir"

case ":$PATH:" in
	*":$bin_dir:"*)
		echo "Run: prime-agent"
		;;
	*)
		echo "Add this to your shell profile, then restart your shell:"
		echo "  export PATH=\"$bin_dir:\$PATH\""
		echo "Then run: prime-agent"
		;;
esac
