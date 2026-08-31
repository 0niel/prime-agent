#!/usr/bin/env bash
set -euo pipefail

launcher="${PRIME_PERF_PRIME_AGENT_BIN:-}"
provider="${PRIME_PERF_PROVIDER:-}"
model="${PRIME_PERF_MODEL:-}"
allow_full_access="${PRIME_PERF_ALLOW_FULL_ACCESS:-0}"
readonly external_safety="Work read-only for external systems: do not comment on, update, publish, or otherwise mutate Tracker, pull requests, Wiki, chats, or remote services. Keep profiling artifacts local."
positional=()

die() {
	printf '[prime-perf] error: %s\n' "$*" >&2
	exit 2
}

while (($# > 0)); do
	case "$1" in
		--print)
			shift
			;;
		--output-format)
			(($# >= 2)) || die "$1 requires a value"
			[[ "$2" == text ]] || die "only --output-format text is supported"
			shift 2
			;;
		--allowedTools)
			(($# >= 2)) || die "$1 requires a value"
			shift 2
			;;
		--dangerously-skip-permissions)
			allow_full_access=1
			shift
			;;
		--model)
			(($# >= 2)) || die "$1 requires a value"
			model="$2"
			shift 2
			;;
		--)
			shift
			positional+=("$@")
			break
			;;
		-*) die "unsupported compatibility option: $1" ;;
		*)
			positional+=("$1")
			shift
			;;
	esac
done

if [[ -z "$launcher" ]]; then
	launcher="$(command -v prime-agent-aisuite 2>/dev/null || true)"
fi
[[ -n "$launcher" && -x "$launcher" ]] || die "prime-agent-aisuite was not found"
[[ "$allow_full_access" == 1 ]] ||
	die "Prime Agent is not sandboxed; keep PERF_AGENT_AUTO_APPROVE=yes or set PRIME_PERF_ALLOW_FULL_ACCESS=1 explicitly"

prompt=""
if [[ ! -t 0 ]]; then
	prompt="$(cat)"
fi
if ((${#positional[@]} > 0)); then
	if [[ -n "$prompt" ]]; then
		prompt+=$'\n'
	fi
	prompt+="${positional[*]}"
fi
[[ -n "$prompt" ]] || die "a profiling prompt is required on stdin or as an argument"

case "$prompt" in
	/skill:eats-perf-profiler*) prompt="/skill:eats-perf-profiler $external_safety${prompt#/skill:eats-perf-profiler}" ;;
	/eats-perf-profiler*) prompt="/skill:eats-perf-profiler $external_safety${prompt#/eats-perf-profiler}" ;;
	*) prompt="/skill:eats-perf-profiler $external_safety $prompt" ;;
esac

args=(--no-session -p --tools ipython,bash,edit)
[[ -z "$provider" ]] || args+=(--provider "$provider")
[[ -z "$model" ]] || args+=(--model "$model")

printf '%s\n' "$prompt" | PRIME_AGENT_TELEMETRY=0 "$launcher" "${args[@]}"
