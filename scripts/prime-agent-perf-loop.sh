#!/usr/bin/env bash
set -euo pipefail

project_dir="${PRIME_PERF_PROJECT_DIR:-$PWD}"
runner="${PRIME_PERF_RUNNER_BIN:-}"

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
if [[ -z "$runner" ]]; then
	runner="$(command -v prime-agent-perf-runner 2>/dev/null || true)"
fi
[[ -n "$runner" && -x "$runner" ]] || die "prime-agent-perf-runner was not found"

find_skill() {
	local candidate
	for candidate in \
		"${project_dir}/.agents/skills/eats-perf-profiler" \
		"${project_dir}/.claude/skills/eats-perf-profiler" \
		"${project_dir}/.codeassistant/skills/eats-perf-profiler"; do
		if [[ -x "${candidate}/scripts/ralph_perf.sh" ]]; then
			printf '%s' "$candidate"
			return 0
		fi
	done
	return 1
}

skill_dir="$(find_skill || true)"
[[ -n "$skill_dir" ]] ||
	die "eats-perf-profiler is not installed in AISuite artifacts; update the project preset after PR 13755284 lands"

EATS_ROOT="$project_dir" exec "${skill_dir}/scripts/ralph_perf.sh" \
	--runner claude --agent-bin "$runner" "$@"
