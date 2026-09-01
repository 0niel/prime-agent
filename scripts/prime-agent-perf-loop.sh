#!/usr/bin/env bash
set -euo pipefail

project_dir="${PRIME_PERF_PROJECT_DIR:-$PWD}"
compat_runner="${PRIME_PERF_RUNNER_BIN:-}"
prime_launcher="${PRIME_PERF_PRIME_AGENT_BIN:-}"

die() {
	printf '[prime-perf] error: %s\n' "$*" >&2
	exit 2
}

for arg in "$@"; do
	case "$arg" in
		--runner | --agent-bin) die "$arg is managed by prime-agent-perf-loop" ;;
	esac
done

project_dir="$(cd "$project_dir" 2>/dev/null && pwd -P)" || die "project directory does not exist: $project_dir"

find_skill() {
	local candidate
	for candidate in \
		"${project_dir}/.agents/skills/eats-perf-profiler" \
		"${project_dir}/.claude/skills/eats-perf-profiler" \
		"${project_dir}/.codeassistant/skills/eats-perf-profiler"; do
		if [[ -f "${candidate}/scripts/ralph_perf.sh" ]]; then
			printf '%s' "$candidate"
			return 0
		fi
	done
	return 1
}

skill_dir="$(find_skill || true)"
[[ -n "$skill_dir" ]] ||
	die "eats-perf-profiler is not installed in AISuite artifacts; update the project preset after PR 13755284 lands"

ralph="${skill_dir}/scripts/ralph_perf.sh"
if grep -q 'auto|claude|opencode|prime' "$ralph"; then
	if [[ -z "$prime_launcher" ]]; then
		prime_launcher="$(command -v prime-agent-aisuite 2>/dev/null || true)"
	fi
	[[ -n "$prime_launcher" && -x "$prime_launcher" ]] || die "prime-agent-aisuite was not found"
	EATS_ROOT="$project_dir" \
		PERF_PRIME_PROVIDER="${PERF_PRIME_PROVIDER:-${PRIME_PERF_PROVIDER:-}}" \
		PERF_AGENT_MODEL="${PERF_AGENT_MODEL:-${PRIME_PERF_MODEL:-}}" \
		exec bash "$ralph" --runner prime --agent-bin "$prime_launcher" "$@"
fi

if [[ -z "$compat_runner" ]]; then
	compat_runner="$(command -v prime-agent-perf-runner 2>/dev/null || true)"
fi
[[ -n "$compat_runner" && -x "$compat_runner" ]] || die "prime-agent-perf-runner was not found"
EATS_ROOT="$project_dir" exec bash "$ralph" \
	--runner claude --agent-bin "$compat_runner" "$@"
