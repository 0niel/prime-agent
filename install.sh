#!/bin/sh

set -eu

# Keep this sentinel split so release publishing only rewrites the install URL
# below; local or unpublished copies still need an unreplaced value to compare.
prime_agent_unconfigured_base_url="__PRIME_AGENT_DOWNLOAD_BASE""_URL__"
prime_agent_base_url="${PRIME_AGENT_DOWNLOAD_BASE_URL:-__PRIME_AGENT_DOWNLOAD_BASE_URL__}"
prime_agent_base_url="${prime_agent_base_url%/}"
prime_agent_package="${PRIME_AGENT_PACKAGE:-prime-agent}"
prime_agent_cmd="${PRIME_AGENT_CMD:-prime-agent}"
prime_agent_esc=$(printf '\033')
prime_agent_original_path="${PATH:-}"
readonly prime_agent_unconfigured_base_url prime_agent_base_url prime_agent_package prime_agent_cmd prime_agent_esc prime_agent_original_path

main() {
	if [ "$prime_agent_base_url" = "$prime_agent_unconfigured_base_url" ]; then
		printf 'error: installer download URL is not configured.\n' >&2
		printf 'Set PRIME_AGENT_DOWNLOAD_BASE_URL or use the installer published by the release workflow.\n' >&2
		exit 1
	fi

	start_preflight_checks

	printf '\n\033[1m  Prime Agent Installer\033[0m\n\033[2m  Installing Prime Agent with npm.\033[0m\n\n'

	if finish_preflight_checks; then
		check_status=0
	else
		check_status=$?
	fi

	if [ "$check_status" -ne 0 ]; then
		if ! install_node_npm_interactive; then
			exit "$check_status"
		fi

		start_preflight_checks
		if finish_preflight_checks; then
			check_status=0
		else
			check_status=$?
		fi

		if [ "$check_status" -ne 0 ]; then
			exit "$check_status"
		fi
	fi

	version="$(resolve_prime_agent_version "$@")"
	tarball_name="$prime_agent_package-$version.tgz"
	tarball_url="$prime_agent_base_url/releases/v$version/$tarball_name"

	printf 'This will download, verify, and install:\n\n  %s\n\n' "$tarball_url"
	confirm_install

	download_dir=$(create_temp_dir)
	trap 'rm -rf "$download_dir"' EXIT
	tarball_path="$download_dir/$tarball_name"

	printf '\n'
	download_prime_agent_package "$version" "$tarball_url" "$tarball_path"
	printf '\n'
	install_prime_agent_package "$tarball_path"
	rm -rf "$download_dir"
	trap - EXIT
	printf '\nPrime Agent was installed successfully.\n'

	if [ "${PRIME_AGENT_NODE_INSTALLED_STANDALONE:-0}" = 1 ]; then
		configure_standalone_node_path
	elif command -v "$prime_agent_cmd" >/dev/null 2>&1; then
		printf '\nRun it with: %s\n' "$prime_agent_cmd"
	else
		cat <<EOF
The $prime_agent_cmd command was installed, but it is not on your PATH yet.
Check npm's global bin directory with:

  npm bin -g

Then add that directory to your shell PATH.
EOF
	fi
}

create_temp_dir() {
	if command -v mktemp >/dev/null 2>&1; then
		if tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/prime-agent-install.XXXXXX" 2>/dev/null); then
			printf '%s' "$tmp_dir"
			return
		fi
	fi

	printf 'error: mktemp is required to create a secure temporary directory.\n' >&2
	exit 1
}

start_preflight_checks() {
	preflight_dir=$(create_temp_dir)
	preflight_file="$preflight_dir/preflight"
	run_preflight_checks >"$preflight_file" &
	preflight_pid=$!
}

finish_preflight_checks() {
	if wait "$preflight_pid"; then
		preflight_status=0
	else
		preflight_status=$?
	fi

	cat "$preflight_file"
	rm -rf "$preflight_dir"
	return "$preflight_status"
}

run_preflight_checks() {
	status=0
	yellow="${prime_agent_esc}[33m"
	reset="${prime_agent_esc}[0m"

	if command -v node >/dev/null 2>&1; then
		node_version=$(node --version)
		if ! node -e 'const [major, minor, patch] = process.versions.node.split(".").map(Number); process.exit(major > 20 || (major === 20 && (minor > 6 || (minor === 6 && patch >= 0))) ? 0 : 1)' >/dev/null; then
			printf 'error: Prime Agent requires Node.js 20.6.0 or newer. Found %s.\n' "$node_version"
			status=1
		fi
	else
		printf 'error: Node.js 20.6.0 or newer is required to install Prime Agent.\n'
		status=1
	fi

	if ! command -v npm >/dev/null 2>&1; then
		printf 'error: npm is required to install Prime Agent.\n'
		status=1
	fi

	if [ "$status" -ne 0 ]; then
		printf '\n'
	fi

	if prime_agent_path=$(command -v "$prime_agent_cmd" 2>/dev/null); then
		printf '%sExisting %s found at: %s%s\n' "$yellow" "$prime_agent_cmd" "$prime_agent_path" "$reset"
		printf '\n'
	fi

	return "$status"
}

resolve_prime_agent_version() {
	if [ "${1:-}" ]; then
		normalize_version "$1"
		return
	fi

	if [ "${PRIME_AGENT_VERSION:-}" ]; then
		normalize_version "$PRIME_AGENT_VERSION"
		return
	fi

	if ! command -v curl >/dev/null 2>&1; then
		printf 'error: curl is required to resolve the latest Prime Agent version.\n' >&2
		exit 1
	fi

	stable_version="$(curl -fsSL "$prime_agent_base_url/stable" | tr -d '[:space:]')"
	if [ -z "$stable_version" ]; then
		printf 'error: could not resolve latest Prime Agent version from %s/stable\n' "$prime_agent_base_url" >&2
		exit 1
	fi
	normalize_version "$stable_version"
}

normalize_version() {
	version="${1#v}"
	case "$version" in
		"")
			printf 'error: empty Prime Agent version.\n' >&2
			exit 1
			;;
		*[!0-9A-Za-z.-]*)
			printf 'error: invalid Prime Agent version: %s\n' "$1" >&2
			exit 1
			;;
	esac
	printf '%s' "$version"
}

install_node_npm_interactive() {
	method=$(detect_node_install_method)
	case "$method" in
		homebrew) label="Homebrew" ;;
		apt) label="apt" ;;
		apk) label="apk" ;;
		standalone) label="standalone Node.js" ;;
		*)
			method=standalone
			label="standalone Node.js"
			;;
	esac

	if ! ( : <>/dev/tty ) 2>/dev/null; then
		printf 'No terminal detected; install Node.js 20.6.0 or newer and npm, then run this installer again.\n'
		return 1
	fi
	exec 3<>/dev/tty

	printf 'Prime Agent needs Node.js 20.6.0 or newer and npm. Install them now with %s? [Y/n] ' "$label" >&3
	if ! IFS= read -r answer <&3; then
		answer=
	fi
	exec 3>&-
	case "$answer" in
		n|N|no|NO)
			printf '\nInstall Node.js 20.6.0 or newer and npm, then run this installer again.\n'
			return 1
			;;
	esac

	install_node_npm "$method" "$label"
}

detect_node_install_method() {
	case "$(uname -s)" in
		Darwin)
			if command -v brew >/dev/null 2>&1; then
				printf 'homebrew'
			else
				printf 'standalone'
			fi
			;;
		Linux)
			if command -v apt-cache >/dev/null 2>&1 && command -v apt-get >/dev/null 2>&1 && apt_node_candidate_is_new_enough; then
				printf 'apt'
			elif command -v apk >/dev/null 2>&1 && apk_node_candidate_is_new_enough; then
				printf 'apk'
			else
				printf 'standalone'
			fi
			;;
		*)
			printf 'standalone'
			;;
	esac
}

apt_node_candidate_is_new_enough() {
	version=$(apt-cache policy nodejs 2>/dev/null | awk '/Candidate:/ { print $2; exit }')
	[ -n "$version" ] && [ "$version" != "(none)" ] && node_version_string_is_new_enough "$version"
}

apk_node_candidate_is_new_enough() {
	version=$(apk search -x nodejs 2>/dev/null | awk -F- '/^nodejs-/ { print $2; exit }')
	[ -n "$version" ] && node_version_string_is_new_enough "$version"
}

node_version_string_is_new_enough() {
	version="${1#v}"
	case "$version" in
		[0-9]*) ;;
		*) return 1 ;;
	esac
	version="${version%%[!0-9.]*}"
	version_ifs=${IFS- }
	IFS=.
	set -- $version
	IFS=$version_ifs
	major="${1:-}"
	minor="${2:-0}"
	patch="${3:-0}"
	case "$major" in ''|*[!0-9]*) return 1 ;; esac
	case "$minor" in ''|*[!0-9]*) minor=0 ;; esac
	case "$patch" in ''|*[!0-9]*) patch=0 ;; esac

	[ "$major" -gt 20 ] && return 0
	[ "$major" -eq 20 ] && [ "$minor" -gt 6 ] && return 0
	[ "$major" -eq 20 ] && [ "$minor" -eq 6 ] && [ "$patch" -ge 0 ] && return 0
	return 1
}

install_node_npm() {
	method="$1"
	label="$2"

	printf '\nInstalling Node.js and npm with %s...\n\n' "$label"
	run_node_install_method "$method"

	if [ "$method" = standalone ]; then
		load_standalone_node
		PRIME_AGENT_NODE_INSTALLED_STANDALONE=1
	fi
	hash -r
	printf '\nNode.js and npm are installed.\n\n'
}

run_node_install_method() {
	case "$1" in
		homebrew) install_node_with_homebrew ;;
		apt) install_node_with_apt ;;
		apk) install_node_with_apk ;;
		standalone) install_node_standalone ;;
	esac
}

install_node_with_homebrew() {
	if brew list node >/dev/null 2>&1; then
		brew upgrade node
	else
		brew install node
	fi
}

install_node_with_apt() {
	print_sudo_note
	if [ "${EUID:-$(id -u)}" -eq 0 ]; then
		apt-get update
		apt-get install -y nodejs npm
	else
		sudo sh -c 'apt-get update && apt-get install -y nodejs npm'
	fi
}

install_node_with_apk() {
	print_sudo_note
	run_with_sudo apk add --update-cache nodejs npm
}

install_node_standalone() {
	node_platform=$(detect_node_binary_platform) || {
		printf 'Unsupported operating system for automatic Node.js install: %s\n' "$(uname -s)"
		return 1
	}
	node_arch=$(detect_node_binary_arch) || {
		printf 'Unsupported CPU architecture for automatic Node.js install: %s\n' "$(uname -m)"
		return 1
	}
	node_dist_base="https://nodejs.org/dist/latest-v22.x"
	node_base_dir=$(node_standalone_base_dir)
	node_tmp_dir=$(create_temp_dir)

	mkdir -p "$node_tmp_dir" "$node_base_dir"

	printf 'Resolving Node.js binary for %s-%s\n' "$node_platform" "$node_arch"
	curl -fsSL "$node_dist_base/SHASUMS256.txt" -o "$node_tmp_dir/SHASUMS256.txt"
	node_file=$(awk -v suffix="-$node_platform-$node_arch.tar.xz" '
		index($2, "node-v") == 1 && length($2) >= length(suffix) && substr($2, length($2) - length(suffix) + 1) == suffix { print $2; exit }
	' "$node_tmp_dir/SHASUMS256.txt")
	if [ -z "$node_file" ]; then
		printf 'No Node.js binary is available for %s-%s.\n' "$node_platform" "$node_arch"
		rm -rf "$node_tmp_dir"
		return 1
	fi
	case "$node_file" in
		*/*|*\\*|*..*)
			printf 'Unsafe Node.js archive name in checksum manifest: %s\n' "$node_file"
			rm -rf "$node_tmp_dir"
			return 1
			;;
		node-v*-"$node_platform"-"$node_arch".tar.xz) ;;
		*)
			printf 'Unexpected Node.js archive name in checksum manifest: %s\n' "$node_file"
			rm -rf "$node_tmp_dir"
			return 1
			;;
	esac

	printf 'Downloading Node.js %s\n' "${node_file%.tar.xz}"
	curl -fsSL "$node_dist_base/$node_file" -o "$node_tmp_dir/$node_file"
	verify_node_standalone_download "$node_tmp_dir" "$node_file"
	ensure_node_standalone_extract_tools "$node_platform"

	node_dir="$node_base_dir/${node_file%.tar.xz}"
	rm -rf "$node_dir"
	printf 'Extracting Node.js to %s\n' "$node_dir"
	tar -xf "$node_tmp_dir/$node_file" -C "$node_base_dir"
	rm -f "$node_base_dir/current"
	ln -s "$node_dir" "$node_base_dir/current"
	rm -rf "$node_tmp_dir"
	printf 'Node.js installed at %s\n' "$node_dir"
}

verify_node_standalone_download() {
	checksum_dir="$1"
	checksum_file_name="$2"
	awk -v file="$checksum_file_name" '$2 == file { print }' "$checksum_dir/SHASUMS256.txt" >"$checksum_dir/SHASUMS256.selected"

	if command -v sha256sum >/dev/null 2>&1; then
		printf 'Verifying Node.js download\n'
		(cd "$checksum_dir" && sha256sum -c SHASUMS256.selected)
	elif command -v shasum >/dev/null 2>&1; then
		printf 'Verifying Node.js download\n'
		(cd "$checksum_dir" && shasum -a 256 -c SHASUMS256.selected)
	else
		printf 'error: sha256sum or shasum is required to verify the Node.js download.\n'
		return 1
	fi
}

ensure_node_standalone_extract_tools() {
	extract_platform="$1"

	if [ "$extract_platform" = linux ] && ! command -v xz >/dev/null 2>&1; then
		printf 'Installing xz-utils for Node.js archive extraction\n'
		print_sudo_note
		if command -v apt-get >/dev/null 2>&1; then
			run_with_sudo apt-get update
			run_with_sudo apt-get install -y xz-utils
		elif command -v apk >/dev/null 2>&1; then
			run_with_sudo apk add --update-cache xz
		else
			printf 'xz is required to extract Node.js. Install xz and run this installer again.\n'
			return 1
		fi
	fi
}

load_standalone_node() {
	PRIME_AGENT_STANDALONE_NODE_BIN="$(node_standalone_base_dir)/current/bin"
	PATH="$PRIME_AGENT_STANDALONE_NODE_BIN:$PATH"
	export PRIME_AGENT_STANDALONE_NODE_BIN PATH
}

node_standalone_base_dir() {
	if [ -n "${XDG_DATA_HOME:-}" ]; then
		printf '%s/prime-agent-node' "$XDG_DATA_HOME"
	else
		printf '%s/.local/share/prime-agent-node' "$HOME"
	fi
}

detect_node_binary_platform() {
	case "$(uname -s)" in
		Darwin) printf 'darwin' ;;
		Linux) printf 'linux' ;;
		*) return 1 ;;
	esac
}

detect_node_binary_arch() {
	case "$(uname -m)" in
		x86_64|amd64) printf 'x64' ;;
		arm64|aarch64) printf 'arm64' ;;
		armv7l) printf 'armv7l' ;;
		ppc64le) printf 'ppc64le' ;;
		s390x) printf 's390x' ;;
		*) return 1 ;;
	esac
}

print_sudo_note() {
	if [ "${EUID:-$(id -u)}" -ne 0 ]; then
		printf 'This may ask for your sudo password.\n\n'
	fi
}

run_with_sudo() {
	if [ "${EUID:-$(id -u)}" -eq 0 ]; then
		"$@"
	else
		sudo "$@"
	fi
}

configure_standalone_node_path() {
	if original_prime_agent_path=$(resolve_prime_agent_with_original_path); then
		case "$original_prime_agent_path" in
			"$PRIME_AGENT_STANDALONE_NODE_BIN/"*)
				printf '\nRun it with: %s\n' "$prime_agent_cmd"
				return 0
				;;
		esac
		printf '%s was installed, but your shell is not using that install yet.\n' "$prime_agent_cmd"
		printf 'Your shell currently resolves %s to: %s\n' "$prime_agent_cmd" "$original_prime_agent_path"
	else
		printf '%s was installed, but your shell is not using that install yet.\n' "$prime_agent_cmd"
	fi

	profile=$(detect_shell_profile) || {
		print_standalone_path_manual_instructions
		return 0
	}

	if shell_profile_has_standalone_node_path "$profile"; then
		printf '%s already contains %s.\n' "$profile" "$PRIME_AGENT_STANDALONE_NODE_BIN"
		printf 'Restart your shell or run: . %s\n' "$profile"
		return 0
	fi

	prompt_add_standalone_node_path "$profile"
}

resolve_prime_agent_with_original_path() {
	saved_path=$PATH
	PATH=$prime_agent_original_path
	if command -v "$prime_agent_cmd" 2>/dev/null; then
		status=0
	else
		status=$?
	fi
	PATH=$saved_path
	return "$status"
}

detect_shell_profile() {
	if [ -n "${PRIME_AGENT_SHELL_PROFILE:-}" ]; then
		printf '%s' "$PRIME_AGENT_SHELL_PROFILE"
		return 0
	fi
	if [ -z "${HOME:-}" ]; then
		return 1
	fi

	shell_name="${SHELL:-}"
	shell_name="${shell_name##*/}"
	case "$shell_name" in
		zsh)
			printf '%s/.zshrc' "${ZDOTDIR:-$HOME}"
			;;
		bash)
			printf '%s/.bashrc' "$HOME"
			;;
		*)
			if [ -f "$HOME/.zshrc" ]; then
				printf '%s/.zshrc' "$HOME"
			elif [ -f "$HOME/.bashrc" ]; then
				printf '%s/.bashrc' "$HOME"
			else
				printf '%s/.profile' "$HOME"
			fi
			;;
	esac
}

shell_profile_has_standalone_node_path() {
	profile="$1"
	[ -f "$profile" ] && grep -F "$PRIME_AGENT_STANDALONE_NODE_BIN" "$profile" >/dev/null 2>&1
}

prompt_add_standalone_node_path() {
	profile="$1"
	path_line=$(standalone_node_path_line)

	if ! ( : <>/dev/tty ) 2>/dev/null; then
		print_standalone_path_manual_instructions
		return 0
	fi
	exec 3<>/dev/tty

	printf 'Add %s to your PATH in %s now? [Y/n] ' "$PRIME_AGENT_STANDALONE_NODE_BIN" "$profile" >&3
	if ! IFS= read -r answer <&3; then
		answer=
	fi
	exec 3>&-
	case "$answer" in
		n|N|no|NO)
			print_standalone_path_manual_instructions
			return 0
			;;
	esac

	mkdir -p "$(dirname "$profile")"
	{
		printf '\n# Prime Agent standalone Node.js\n'
		printf '%s\n' "$path_line"
	} >>"$profile"
	printf 'Added %s to %s.\n' "$PRIME_AGENT_STANDALONE_NODE_BIN" "$profile"
	printf 'Restart your shell or run: . %s\n' "$profile"
}

print_standalone_path_manual_instructions() {
	printf 'Add this to your shell profile to use %s from new shells:\n\n' "$prime_agent_cmd"
	printf '  %s\n' "$(standalone_node_path_line)"
}

standalone_node_path_line() {
	printf 'export PATH="%s:$PATH"' "$PRIME_AGENT_STANDALONE_NODE_BIN"
}

download_prime_agent_package() {
	version="$1"
	tarball_url="$2"
	tarball_path="$3"
	download_dir=$(dirname "$tarball_path")
	checksums_url="$prime_agent_base_url/releases/v$version/SHA256SUMS"
	checksums_path="$download_dir/SHA256SUMS"

	if ! command -v curl >/dev/null 2>&1; then
		printf 'error: curl is required to download Prime Agent.\n' >&2
		exit 1
	fi

	printf 'Downloading checksums...\n'
	curl -fsSL "$checksums_url" -o "$checksums_path"

	printf 'Downloading Prime Agent...\n'
	curl -fL "$tarball_url" -o "$tarball_path"

	verify_prime_agent_package_checksum "$checksums_path" "$tarball_path"
}

verify_prime_agent_package_checksum() {
	checksums_path="$1"
	tarball_path="$2"
	checksum_dir=$(dirname "$tarball_path")
	tarball_name=$(basename "$tarball_path")
	selected_checksums_path="$checksum_dir/SHA256SUMS.selected"

	if ! awk -v file="$tarball_name" '$2 == file { print; found = 1; exit } END { if (!found) exit 1 }' \
		"$checksums_path" >"$selected_checksums_path"; then
		printf 'error: checksum for %s was not found in %s\n' "$tarball_name" "$checksums_path" >&2
		exit 1
	fi

	if command -v sha256sum >/dev/null 2>&1; then
		printf 'Verifying Prime Agent download\n'
		(cd "$checksum_dir" && sha256sum -c "$(basename "$selected_checksums_path")")
	elif command -v shasum >/dev/null 2>&1; then
		printf 'Verifying Prime Agent download\n'
		(cd "$checksum_dir" && shasum -a 256 -c "$(basename "$selected_checksums_path")")
	else
		printf 'error: sha256sum or shasum is required to verify the Prime Agent download.\n' >&2
		exit 1
	fi
}

confirm_install() {
	if ! ( : <>/dev/tty ) 2>/dev/null; then
		printf 'No terminal detected; continuing without confirmation.\n'
		return 0
	fi
	exec 3<>/dev/tty

	printf 'Continue? [Y/n] ' >&3
	if ! IFS= read -r answer <&3; then
		answer=
	fi
	exec 3>&-
	case "$answer" in
		n|N|no|NO)
			printf '\nInstallation cancelled.\n'
			exit 0
			;;
	esac
}

install_prime_agent_package() {
	tarball_path="$1"
	printf 'Installing Prime Agent...\n\n'
	npm install -g --no-fund --no-audit --loglevel=error --progress=false "$tarball_path"
}

main "$@"
