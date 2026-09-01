#!/usr/bin/env bash

set -Eeuo pipefail

readonly DEFAULT_REPO_URL="https://github.com/0niel/prime-agent.git"
readonly DEFAULT_BRANCH="feat/aisuite-harness-integration"
readonly DEFAULT_PRIME_INSTALLER_URL="https://app.primeintellect.ai/prime-agent/install.sh"
readonly DEFAULT_PRIME_RELEASE_BASE_URL="https://pub-728493de92a943e2a9b2d17b4719f318.r2.dev"

repo_url="${PRIME_AISUITE_REPO_URL:-$DEFAULT_REPO_URL}"
branch="${PRIME_AISUITE_BRANCH:-$DEFAULT_BRANCH}"
repo_dir="${PRIME_AISUITE_REPO_DIR:-${HOME}/.local/share/prime-agent-aisuite/repo}"
project_dir="${PRIME_AISUITE_PROJECT_DIR:-}"
bin_dir="${PRIME_AISUITE_BIN_DIR:-}"
agent_dir="${PRIME_AISUITE_AGENT_DIR:-${HOME}/.prime/agent}"
state_dir="${PRIME_AISUITE_STATE_DIR:-${HOME}/.local/share/prime-agent-aisuite}"
token_source="${PRIME_AISUITE_TOKEN_SOURCE:-auto}"
prime_agent_bin="${PRIME_AISUITE_PRIME_AGENT_BIN:-}"
prime_installer_url="${PRIME_AISUITE_PRIME_INSTALLER_URL:-$DEFAULT_PRIME_INSTALLER_URL}"
prime_release_base_url="${PRIME_AISUITE_PRIME_RELEASE_BASE_URL:-$DEFAULT_PRIME_RELEASE_BASE_URL}"
node_bin=""
auth_command=""
skip_prime_install="${PRIME_AISUITE_SKIP_PRIME_INSTALL:-0}"
skip_aisuite_setup="${PRIME_AISUITE_SKIP_AISUITE_SETUP:-0}"
skip_live_smoke="${PRIME_AISUITE_SKIP_LIVE_SMOKE:-0}"
non_interactive="${PRIME_AISUITE_NON_INTERACTIVE:-0}"
provided_token="${ELIZA_API_TOKEN:-}"
unset ELIZA_API_TOKEN
temp_dir=""
lock_dir=""

usage() {
	cat <<'EOF'
Install Prime Agent + AISuite bridge + Eliza models in one pass.

Usage:
  install-aisuite-eliza.sh [options]

Options:
  --repo-dir PATH          Fork checkout destination
  --repo-url URL           Fork URL
  --branch NAME            Fork branch
  --project-dir PATH       AISuite project to configure
  --bin-dir PATH           Launcher destination directory
  --token-source SOURCE    auto, ya, or prompt
  --skip-prime-install     Keep the installed prime-agent binary
  --skip-aisuite-setup     Reuse generated AISuite artifacts
  --skip-live-smoke        Do not send the final Eliza smoke request
  --non-interactive        Never prompt; use ya or ELIZA_API_TOKEN
  -h, --help               Show this help

Manual tokens are read from /dev/tty without echo and stored in a mode-600
file. They are never written to shell history, process arguments, or models.json.
For unattended installation, set ELIZA_API_TOKEN in the process environment.
EOF
}

log() {
	printf '[prime-aisuite] %s\n' "$*"
}

die() {
	printf '[prime-aisuite] error: %s\n' "$*" >&2
	exit 1
}

shell_quote() {
	local escaped
	escaped="$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
	printf "'%s'" "$escaped"
}

has_tty() {
	( : <>/dev/tty ) 2>/dev/null
}

cleanup() {
	local status=$?
	if [[ -n "$temp_dir" && -d "$temp_dir" ]]; then
		rm -rf -- "$temp_dir"
	fi
	if [[ -n "$lock_dir" && -d "$lock_dir" ]]; then
		rmdir "$lock_dir" 2>/dev/null || true
	fi
	return "$status"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

while (($# > 0)); do
	case "$1" in
		--repo-dir | --repo-url | --branch | --project-dir | --bin-dir | --token-source)
			(($# >= 2)) || die "$1 requires a value"
			case "$1" in
				--repo-dir) repo_dir="$2" ;;
				--repo-url) repo_url="$2" ;;
				--branch) branch="$2" ;;
				--project-dir) project_dir="$2" ;;
				--bin-dir) bin_dir="$2" ;;
				--token-source) token_source="$2" ;;
			esac
			shift 2
			;;
		--skip-prime-install)
			skip_prime_install=1
			shift
			;;
		--skip-aisuite-setup)
			skip_aisuite_setup=1
			shift
			;;
		--skip-live-smoke)
			skip_live_smoke=1
			shift
			;;
		--non-interactive)
			non_interactive=1
			shift
			;;
		-h | --help)
			usage
			exit 0
			;;
		*) die "unknown option: $1" ;;
	esac
done

case "$token_source" in
	auto | ya | prompt) ;;
	*) die "--token-source must be auto, ya, or prompt" ;;
esac

for flag in "$skip_prime_install" "$skip_aisuite_setup" "$skip_live_smoke" "$non_interactive"; do
	[[ "$flag" == 0 || "$flag" == 1 ]] || die "boolean environment options must be 0 or 1"
done

command -v git >/dev/null 2>&1 || die "git is required"

if [[ -z "$project_dir" ]]; then
	if [[ -d "${HOME}/arcadia/flutter/pro/yxpro/professions/eats" ]]; then
		project_dir="${HOME}/arcadia/flutter/pro/yxpro/professions/eats"
	else
		project_dir="$PWD"
	fi
fi
project_dir="$(cd "$project_dir" 2>/dev/null && pwd -P)" || die "project directory does not exist: $project_dir"

mkdir -p "$agent_dir"
chmod 700 "$agent_dir"
agent_dir="$(cd "$agent_dir" && pwd -P)"
mkdir -p "$state_dir"
chmod 700 "$state_dir"
state_dir="$(cd "$state_dir" && pwd -P)"
lock_dir="${state_dir}/install.lock"
mkdir "$lock_dir" 2>/dev/null || die "another AISuite installer is already running: $lock_dir"

temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/prime-aisuite-install.XXXXXX")"

install_prime_agent() {
	if [[ "$skip_prime_install" == 0 ]]; then
		command -v curl >/dev/null 2>&1 || die "curl is required to install Prime Agent"
		local installer="${temp_dir}/prime-agent-install.sh"
		log "downloading the official stable Prime Agent installer"
		if curl --proto '=https' --tlsv1.2 --connect-timeout 10 --max-time 30 -fsSL \
			"$prime_installer_url" -o "$installer" 2>"${temp_dir}/prime-installer-download.log"; then
			PRIME_AGENT_INSTALLER_PLAIN=1 sh "$installer"
		else
			installer="${repo_dir}/install.sh"
			[[ -f "$installer" && ! -L "$installer" ]] || die "trusted fallback installer is missing: $installer"
			log "official installer endpoint is unavailable; using the checked-out installer with the release CDN"
			PRIME_AGENT_DOWNLOAD_BASE_URL="$prime_release_base_url" \
				PRIME_AGENT_INSTALLER_PLAIN=1 sh "$installer"
		fi
	fi

	if [[ -z "$prime_agent_bin" ]]; then
		prime_agent_bin="$(command -v prime-agent 2>/dev/null || true)"
	fi
	if [[ -z "$prime_agent_bin" && -x "${HOME}/.local/bin/prime-agent" ]]; then
		prime_agent_bin="${HOME}/.local/bin/prime-agent"
	fi
	local standalone_bin="${XDG_DATA_HOME:-${HOME}/.local/share}/prime-agent-node/current/bin"
	if [[ -z "$prime_agent_bin" && -x "${standalone_bin}/prime-agent" ]]; then
		PATH="${standalone_bin}:${PATH}"
		export PATH
		prime_agent_bin="${standalone_bin}/prime-agent"
	fi
	if [[ -z "$prime_agent_bin" ]] && command -v npm >/dev/null 2>&1; then
		local npm_bin
		npm_bin="$(npm prefix -g 2>/dev/null || true)/bin/prime-agent"
		if [[ -x "$npm_bin" ]]; then
			prime_agent_bin="$npm_bin"
		fi
	fi
	[[ -n "$prime_agent_bin" && -x "$prime_agent_bin" ]] || die "prime-agent was not found after installation"
	prime_agent_bin="$(cd "$(dirname "$prime_agent_bin")" && pwd -P)/$(basename "$prime_agent_bin")"
	local version
	version="$("$prime_agent_bin" --version 2>&1)"
	log "Prime Agent: $version"
}

checkout_fork() {
	if [[ ! -e "$repo_dir" ]]; then
		mkdir -p "$(dirname "$repo_dir")"
		log "cloning $repo_url ($branch)"
		git clone --single-branch --branch "$branch" "$repo_url" "$repo_dir"
	else
		[[ -d "$repo_dir/.git" ]] || die "repo destination exists but is not a Git checkout: $repo_dir"
		local actual_url current_branch
		actual_url="$(git -C "$repo_dir" remote get-url origin)"
		[[ "$actual_url" == "$repo_url" ]] || die "existing checkout has a different origin: $actual_url"
		[[ -z "$(git -C "$repo_dir" status --porcelain)" ]] || die "existing fork checkout has uncommitted changes: $repo_dir"
		current_branch="$(git -C "$repo_dir" branch --show-current)"
		[[ "$current_branch" == "$branch" ]] || die "existing checkout is on $current_branch, expected $branch"
		log "updating fork checkout with a fast-forward only"
		git -C "$repo_dir" fetch origin "$branch"
		git -C "$repo_dir" merge --ff-only FETCH_HEAD
	fi

	repo_dir="$(cd "$repo_dir" && pwd -P)"
	extension_dir="${repo_dir}/packages/coding-agent/examples/extensions/aisuite"
	[[ -f "${extension_dir}/index.ts" ]] || die "AISuite extension is missing from the selected branch"
}

has_aisuite_manifest() {
	[[ -f "${project_dir}/.codeassistant/aisuite_generated_artifacts.json" ||
		-f "${project_dir}/.claude/aisuite_generated_artifacts.json" ||
		-f "${project_dir}/.codex/aisuite_generated_artifacts.json" ]]
}

find_project_skill() {
	local name="$1"
	local candidate
	for candidate in \
		"${project_dir}/.agents/skills/${name}" \
		"${project_dir}/.claude/skills/${name}" \
		"${project_dir}/.codeassistant/skills/${name}"; do
		if [[ -f "${candidate}/SKILL.md" ]]; then
			printf '%s' "$candidate"
			return 0
		fi
	done
	return 1
}

validate_aisuite_config() {
	local config_path="${project_dir}/aisuite.yaml"
	local validation_output

	log "validating $config_path"
	if validation_output="$(ya tool aisuite validate "$config_path" 2>&1)"; then
		[[ -z "$validation_output" ]] || printf '%s\n' "$validation_output"
		return
	fi

	if [[ "$validation_output" == *"$config_path"* && "$validation_output" == *"is a file"* ]]; then
		log "installed AISuite expects a project directory; retrying validation with $project_dir"
		ya tool aisuite validate "$project_dir"
		return
	fi

	printf '%s\n' "$validation_output" >&2
	return 1
}

setup_aisuite() {
	if [[ "$skip_aisuite_setup" == 0 && -x "$(command -v ya 2>/dev/null || true)" ]]; then
		if [[ -f "${project_dir}/aisuite.yaml" ]]; then
			validate_aisuite_config
		fi
		log "generating AISuite rules, skills, commands, and hooks"
		ya tool aisuite setup "$project_dir"
	elif [[ "$skip_aisuite_setup" == 0 ]]; then
		log "ya is unavailable; reusing existing generated AISuite artifacts"
	fi

	has_aisuite_manifest || die "AISuite artifacts are missing in $project_dir; install ya and run: ya tool aisuite setup '$project_dir'"
	duty_skill_dir="$(find_project_skill duty-cracker || true)"
	[[ -n "$duty_skill_dir" ]] || die "duty-cracker is not installed by the project preset; for Eats, use the pro/mobile/eats preset"
	log "duty-cracker: $duty_skill_dir"
	perf_skill_dir="$(find_project_skill eats-perf-profiler || true)"
	if [[ -n "$perf_skill_dir" ]]; then
		log "eats-perf-profiler: $perf_skill_dir"
	else
		log "eats-perf-profiler is not installed yet; the Prime runner will become available after the AISuite preset includes it"
	fi
}

read_manual_token() {
	local token="$provided_token"
	if [[ -z "$token" ]]; then
		[[ "$non_interactive" == 0 ]] || die "ELIZA_API_TOKEN is required for non-interactive prompt auth"
		has_tty || die "a terminal is required to read the Eliza token securely"
		printf 'Eliza token (input hidden): ' >/dev/tty
		IFS= read -r -s token </dev/tty
		printf '\n' >/dev/tty
	fi
	[[ -n "$token" ]] || die "Eliza token cannot be empty"

	local secret_dir="${agent_dir}/secrets"
	local token_path="${secret_dir}/eliza-token"
	local token_temp
	mkdir -p "$secret_dir"
	chmod 700 "$secret_dir"
	[[ ! -L "$token_path" ]] || die "refusing to replace symlinked token file: $token_path"
	token_temp="$(mktemp "${secret_dir}/.eliza-token.XXXXXX")"
	chmod 600 "$token_temp"
	printf '%s' "$token" >"$token_temp"
	mv -f "$token_temp" "$token_path"
	unset token provided_token
	auth_command="!cat $(shell_quote "$token_path")"
}

choose_auth_command() {
	local ya_bin=""
	ya_bin="$(command -v ya 2>/dev/null || true)"

	if [[ "$token_source" == auto && -n "$ya_bin" && "$non_interactive" == 0 ]] && has_tty; then
		local answer
		printf 'Use an automatically refreshed Eliza token from ya? [Y/n] ' >/dev/tty
		IFS= read -r answer </dev/tty || answer=""
		case "$answer" in
			n | N | no | NO) token_source=prompt ;;
			*) token_source=ya ;;
		esac
	elif [[ "$token_source" == auto ]]; then
		if [[ -n "$ya_bin" ]]; then
			token_source=ya
		else
			token_source=prompt
		fi
	fi

	if [[ "$token_source" == ya ]]; then
		[[ -n "$ya_bin" ]] || die "ya is required for --token-source ya"
		auth_command="!$(shell_quote "$ya_bin") tool fetch-token -preset eliza"
	else
		read_manual_token
	fi
}

configure_models() {
	node_bin="$(command -v node 2>/dev/null || true)"
	if [[ -z "$node_bin" ]]; then
		local standalone_node="${XDG_DATA_HOME:-${HOME}/.local/share}/prime-agent-node/current/bin/node"
		[[ -x "$standalone_node" ]] && node_bin="$standalone_node"
	fi
	[[ -n "$node_bin" ]] || die "Node.js is required to merge models.json"
	local models_path="${agent_dir}/models.json"
	mkdir -p "$agent_dir"
	chmod 700 "$agent_dir"
	[[ ! -L "$models_path" ]] || die "refusing to replace symlinked models file: $models_path"
	choose_auth_command

	AISUITE_MODELS_PATH="$models_path" AISUITE_AUTH_COMMAND="$auth_command" "$node_bin" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const modelsPath = process.env.AISUITE_MODELS_PATH;
const apiKey = process.env.AISUITE_AUTH_COMMAND;
if (!modelsPath || !apiKey) throw new Error("missing installer model configuration");

let root = {};
if (fs.existsSync(modelsPath)) {
	root = JSON.parse(fs.readFileSync(modelsPath, "utf8"));
	if (!root || typeof root !== "object" || Array.isArray(root)) throw new Error("models.json root must be an object");
}
const existingProviders = root.providers && typeof root.providers === "object" && !Array.isArray(root.providers) ? root.providers : {};
const compat = {
	supportsDeveloperRole: false,
	supportsReasoningEffort: false,
	supportsUsageInStreaming: false,
	maxTokensField: "max_tokens",
	supportsStrictMode: false,
};
const free = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const providers = {
	"eliza-openai": {
		baseUrl: "https://api.eliza.yandex.net/raw/openai/v1",
		api: "openai-responses",
		apiKey,
		authHeader: true,
		models: [
			{ id: "gpt-5.6-luna", name: "Eliza GPT-5.6 Luna", reasoning: true, input: ["text", "image"], contextWindow: 400000, maxTokens: 128000, cost: free },
			{ id: "gpt-5.6-terra", name: "Eliza GPT-5.6 Terra", reasoning: true, input: ["text", "image"], contextWindow: 1050000, maxTokens: 128000, cost: free },
			{ id: "gpt-5.6-sol", name: "Eliza GPT-5.6 Sol", reasoning: true, input: ["text", "image"], contextWindow: 1050000, maxTokens: 128000, cost: free },
		],
	},
	"eliza-deepseek-internal": {
		baseUrl: "https://api.eliza.yandex.net/raw/internal/deepseek-v4-flash/v1",
		api: "openai-completions",
		apiKey,
		authHeader: true,
		compat,
		models: [{ id: "deepseek-v4-flash", name: "Eliza Internal DeepSeek V4 Flash", reasoning: false, input: ["text"], contextWindow: 262144, maxTokens: 8192, cost: free }],
	},
	"eliza-qwen-internal": {
		baseUrl: "https://api.eliza.yandex.net/raw/internal/qwen3-6-27b-fp8/v1",
		api: "openai-completions",
		apiKey,
		authHeader: true,
		compat,
		models: [{ id: "qwen3-6-27b-fp8", name: "Eliza Internal Qwen 3.6 27B", reasoning: false, input: ["text", "image"], contextWindow: 262144, maxTokens: 8192, cost: free }],
	},
	"eliza-gpt-oss-internal": {
		baseUrl: "https://api.eliza.yandex.net/raw/internal/gpt-oss-120b/v1",
		api: "openai-completions",
		apiKey,
		authHeader: true,
		compat,
		models: [{ id: "gpt-oss-120b", name: "Eliza Internal GPT-OSS 120B", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 8192, cost: free }],
	},
	"eliza-claude": {
		baseUrl: "https://api.eliza.yandex.net/raw/openrouter/v1",
		api: "openai-completions",
		apiKey,
		authHeader: true,
		models: [
			{ id: "anthropic/claude-sonnet-5", name: "Eliza Claude Sonnet 5", reasoning: true, input: ["text", "image"], contextWindow: 1000000, maxTokens: 128000, cost: free },
			{ id: "anthropic/claude-opus-5", name: "Eliza Claude Opus 5", reasoning: true, input: ["text", "image"], contextWindow: 1000000, maxTokens: 128000, cost: free },
		],
	},
};

const output = { ...root, providers: { ...existingProviders, ...providers } };
const tempPath = `${modelsPath}.${process.pid}.tmp`;
fs.writeFileSync(tempPath, `${JSON.stringify(output, null, 2)}\n`, { mode: 0o600 });
fs.chmodSync(tempPath, 0o600);
fs.renameSync(tempPath, modelsPath);
NODE

	chmod 600 "$models_path"
	log "Eliza providers merged into $models_path"
}

install_launcher() {
	if [[ -z "$bin_dir" ]]; then
		local prime_bin_dir
		prime_bin_dir="$(dirname "$prime_agent_bin")"
		if [[ -w "$prime_bin_dir" ]]; then
			bin_dir="$prime_bin_dir"
		else
			bin_dir="${HOME}/.local/bin"
		fi
	fi
	mkdir -p "$bin_dir"
	bin_dir="$(cd "$bin_dir" && pwd -P)"
	local launcher="${bin_dir}/prime-agent-aisuite"
	local launcher_temp
	launcher_temp="$(mktemp "${bin_dir}/.prime-agent-aisuite.XXXXXX")"
	{
		printf '%s\n' '#!/usr/bin/env bash' 'set -euo pipefail' ''
		printf 'export PRIME_AGENT_CODING_AGENT_DIR=%q\n' "$agent_dir"
		printf 'exec %q --extension %q --provider "${PRIME_AISUITE_PROVIDER:-eliza-deepseek-internal}" --model "${PRIME_AISUITE_MODEL:-deepseek-v4-flash}" "$@"\n' "$prime_agent_bin" "$extension_dir"
	} >"$launcher_temp"
	chmod 755 "$launcher_temp"
	mv -f "$launcher_temp" "$launcher"
	launcher_path="$launcher"
	log "launcher: $launcher_path"

	case ":${PATH}:" in
		*":${bin_dir}:"*) ;;
		*) log "add this to your shell profile: export PATH=\"${bin_dir}:\$PATH\"" ;;
	esac
}

install_perf_launchers() {
	local runner_source="${repo_dir}/scripts/prime-agent-perf-runner.sh"
	local loop_source="${repo_dir}/scripts/prime-agent-perf-loop.sh"
	[[ -x "$runner_source" && -x "$loop_source" ]] || die "Prime performance runner scripts are missing from the selected branch"

	perf_runner_path="${bin_dir}/prime-agent-perf-runner"
	local runner_temp
	runner_temp="$(mktemp "${bin_dir}/.prime-agent-perf-runner.XXXXXX")"
	{
		printf '%s\n' '#!/usr/bin/env bash' 'set -euo pipefail' ''
		printf 'export PRIME_PERF_PRIME_AGENT_BIN=%q\n' "$launcher_path"
		printf 'exec %q "$@"\n' "$runner_source"
	} >"$runner_temp"
	chmod 755 "$runner_temp"
	mv -f "$runner_temp" "$perf_runner_path"

	perf_loop_path="${bin_dir}/prime-agent-perf-loop"
	local loop_temp
	loop_temp="$(mktemp "${bin_dir}/.prime-agent-perf-loop.XXXXXX")"
	{
		printf '%s\n' '#!/usr/bin/env bash' 'set -euo pipefail' ''
		printf 'export PRIME_PERF_PROJECT_DIR=%q\n' "$project_dir"
		printf 'export PRIME_PERF_RUNNER_BIN=%q\n' "$perf_runner_path"
		printf 'exec %q "$@"\n' "$loop_source"
	} >"$loop_temp"
	chmod 755 "$loop_temp"
	mv -f "$loop_temp" "$perf_loop_path"
	log "performance loop: $perf_loop_path"
}

run_smoke() {
	"$launcher_path" --version >/dev/null 2>&1
	if [[ "$skip_live_smoke" == 1 ]]; then
		log "live Eliza smoke skipped"
		return
	fi
	log "running a no-session Eliza completion smoke"
	local output
	output="$(cd "$project_dir" && PRIME_AGENT_TELEMETRY=0 "$launcher_path" --no-session -p 'Do not call tools or access external systems. Reply with exactly ELIZA_INSTALL_OK.')"
	[[ "$output" == *"ELIZA_INSTALL_OK"* ]] || die "Eliza smoke failed: $output"
	log "Eliza smoke: ELIZA_INSTALL_OK"
}

checkout_fork
install_prime_agent
setup_aisuite
configure_models
install_launcher
install_perf_launchers
run_smoke

cat <<EOF

Installation complete.

  Project:  $project_dir
  Fork:     $repo_dir
  Launcher: $launcher_path
  Skill:    $duty_skill_dir

Performance profiling (after eats-perf-profiler is installed):

  $(printf '%q' "$perf_loop_path") --max 3 --sleep 10

Start the UI:

  cd $(printf '%q' "$project_dir")
  $(printf '%q' "$launcher_path")

Inside Prime Agent:

  /aisuite-status
  /aisuite-readonly on
  /skill:duty-cracker
EOF
