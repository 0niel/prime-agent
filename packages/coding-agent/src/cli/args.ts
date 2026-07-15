/**
 * CLI argument parsing and help display
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import chalk from "chalk";
import { APP_NAME, CONFIG_DIR_NAME, ENV_AGENT_DIR, ENV_SESSION_DIR } from "../config.js";
import type { ExtensionFlag } from "../core/extensions/types.js";

export type Mode = "text" | "json" | "rpc" | "daemon";

export interface Args {
	provider?: string;
	model?: string;
	apiKey?: string;
	cwd?: string;
	systemPrompt?: string;
	appendSystemPrompt?: string[];
	thinking?: ThinkingLevel;
	plan?: boolean;
	continue?: boolean;
	resume?: true | string;
	resumeSelectorFallback?: string;
	help?: boolean;
	version?: boolean;
	mode?: Mode;
	daemonSocket?: string;
	noSession?: boolean;
	fork?: string;
	sessionDir?: string;
	models?: string[];
	tools?: string[];
	noTools?: boolean;
	noBuiltinTools?: boolean;
	extensions?: string[];
	noExtensions?: boolean;
	print?: boolean;
	export?: string;
	noSkills?: boolean;
	skills?: string[];
	promptTemplates?: string[];
	noPromptTemplates?: boolean;
	themes?: string[];
	noThemes?: boolean;
	noContextFiles?: boolean;
	autonomous?: boolean;
	autonomousGates?: string[];
	autonomousGateRetries?: number;
	autonomousGateTimeoutMs?: number;
	autonomousMaxContinuations?: number;
	autonomousMaxTurns?: number;
	autonomousMaxTokens?: number;
	autonomousTimeoutMs?: number;
	listModels?: string | true;
	offline?: boolean;
	verbose?: boolean;
	messages: string[];
	fileArgs: string[];
	/** Unknown flags (potentially extension flags) - map of flag name to value */
	unknownFlags: Map<string, boolean | string>;
	diagnostics: Array<{ type: "warning" | "error"; message: string }>;
}

const VALID_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const REMOVED_BUILTIN_TOOL_NAMES = new Set(["read", "write", "grep", "find", "ls"]);
const BUILTIN_TOOL_NAMES = ["ipython"];

export function isValidThinkingLevel(level: string): level is ThinkingLevel {
	return VALID_THINKING_LEVELS.includes(level as ThinkingLevel);
}

export function parseArgs(args: string[]): Args {
	const result: Args = {
		messages: [],
		fileArgs: [],
		unknownFlags: new Map(),
		diagnostics: [],
	};

	let endOfOptions = false;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];

		// POSIX end-of-options: everything after a standalone "--" is a positional
		// message, even if it starts with a dash (e.g. a Markdown-bullet prompt).
		if (endOfOptions) {
			result.messages.push(arg);
			continue;
		}
		if (arg === "--") {
			endOfOptions = true;
			continue;
		}

		if (arg === "--help" || arg === "-h") {
			result.help = true;
		} else if (arg === "--version" || arg === "-v") {
			result.version = true;
		} else if (arg === "--mode" && i + 1 < args.length) {
			const mode = args[++i];
			if (mode === "text" || mode === "json" || mode === "rpc" || mode === "daemon") {
				result.mode = mode;
			}
		} else if (arg === "--daemon-socket" && i + 1 < args.length) {
			result.daemonSocket = args[++i];
		} else if (arg === "--continue" || arg === "-c") {
			result.continue = true;
		} else if (arg === "--resume" || arg === "-r") {
			const next = args[i + 1];
			if (next !== undefined && !next.startsWith("-") && !next.startsWith("@")) {
				if (next === "") {
					result.resume = true;
					i++;
				} else {
					result.resume = next;
					result.resumeSelectorFallback = next;
					i++;
				}
			} else {
				result.resume = true;
			}
		} else if (arg.startsWith("--resume=")) {
			const value = arg.slice("--resume=".length);
			if (!value) {
				result.resume = true;
			} else {
				result.resume = value;
				result.resumeSelectorFallback = value;
			}
		} else if (arg === "--provider" && i + 1 < args.length) {
			result.provider = args[++i];
		} else if (arg === "--model" && i + 1 < args.length) {
			result.model = args[++i];
		} else if (arg === "--api-key" && i + 1 < args.length) {
			result.apiKey = args[++i];
		} else if (arg === "--cwd" && i + 1 < args.length) {
			result.cwd = args[++i];
		} else if (arg === "--system-prompt" && i + 1 < args.length) {
			result.systemPrompt = args[++i];
		} else if (arg === "--append-system-prompt" && i + 1 < args.length) {
			result.appendSystemPrompt = result.appendSystemPrompt ?? [];
			result.appendSystemPrompt.push(args[++i]);
		} else if (arg === "--no-session") {
			result.noSession = true;
		} else if (arg === "--fork" && i + 1 < args.length) {
			result.fork = args[++i];
		} else if (arg === "--session-dir" && i + 1 < args.length) {
			result.sessionDir = args[++i];
		} else if (arg === "--models" && i + 1 < args.length) {
			result.models = args[++i].split(",").map((s) => s.trim());
		} else if (arg === "--no-tools" || arg === "-nt") {
			result.noTools = true;
		} else if (arg === "--no-builtin-tools" || arg === "-nbt") {
			result.noBuiltinTools = true;
		} else if ((arg === "--tools" || arg === "-t") && i + 1 < args.length) {
			result.tools = args[++i]
				.split(",")
				.map((s) => s.trim())
				.filter((name) => name.length > 0);
			const removedTools = result.tools.filter((name) => REMOVED_BUILTIN_TOOL_NAMES.has(name));
			if (removedTools.length > 0) {
				result.diagnostics.push({
					type: "error",
					message: `Unknown built-in tool(s): ${removedTools.join(", ")}. Available built-in tools: ${BUILTIN_TOOL_NAMES.join(", ")}`,
				});
			}
		} else if (arg === "--thinking" && i + 1 < args.length) {
			const level = args[++i];
			if (isValidThinkingLevel(level)) {
				result.thinking = level;
			} else {
				result.diagnostics.push({
					type: "warning",
					message: `Invalid thinking level "${level}". Valid values: ${VALID_THINKING_LEVELS.join(", ")}`,
				});
			}
		} else if (arg === "--plan") {
			result.plan = true;
		} else if (arg === "--print" || arg === "-p") {
			result.print = true;
			const next = args[i + 1];
			if (next !== undefined && !next.startsWith("@") && (!next.startsWith("-") || next.startsWith("---"))) {
				result.messages.push(next);
				i++;
			}
		} else if (arg === "--export" && i + 1 < args.length) {
			result.export = args[++i];
		} else if ((arg === "--extension" || arg === "-e") && i + 1 < args.length) {
			result.extensions = result.extensions ?? [];
			result.extensions.push(args[++i]);
		} else if (arg === "--no-extensions" || arg === "-ne") {
			result.noExtensions = true;
		} else if (arg === "--skill" && i + 1 < args.length) {
			result.skills = result.skills ?? [];
			result.skills.push(args[++i]);
		} else if (arg === "--prompt-template" && i + 1 < args.length) {
			result.promptTemplates = result.promptTemplates ?? [];
			result.promptTemplates.push(args[++i]);
		} else if (arg === "--theme" && i + 1 < args.length) {
			result.themes = result.themes ?? [];
			result.themes.push(args[++i]);
		} else if (arg === "--no-skills" || arg === "-ns") {
			result.noSkills = true;
		} else if (arg === "--no-prompt-templates" || arg === "-np") {
			result.noPromptTemplates = true;
		} else if (arg === "--no-themes") {
			result.noThemes = true;
		} else if (arg === "--no-context-files" || arg === "-nc") {
			result.noContextFiles = true;
		} else if (arg === "--autonomous") {
			result.autonomous = true;
		} else if (arg === "--autonomous-gate") {
			result.autonomous = true;
			if (hasRequiredOptionValue(args, i, arg, result)) {
				result.autonomousGates = result.autonomousGates ?? [];
				result.autonomousGates.push(args[++i]);
			}
		} else if (arg === "--autonomous-gate-retries") {
			result.autonomous = true;
			if (hasRequiredOptionValue(args, i, arg, result)) {
				result.autonomousGateRetries = parsePositiveInt(args[++i], "--autonomous-gate-retries", result);
			}
		} else if (arg === "--autonomous-gate-timeout-ms") {
			result.autonomous = true;
			if (hasRequiredOptionValue(args, i, arg, result)) {
				result.autonomousGateTimeoutMs = parsePositiveInt(args[++i], "--autonomous-gate-timeout-ms", result);
			}
		} else if (arg === "--autonomous-max-continuations") {
			result.autonomous = true;
			if (hasRequiredOptionValue(args, i, arg, result)) {
				result.autonomousMaxContinuations = parsePositiveInt(args[++i], "--autonomous-max-continuations", result);
			}
		} else if (arg === "--autonomous-max-turns") {
			result.autonomous = true;
			if (hasRequiredOptionValue(args, i, arg, result)) {
				result.autonomousMaxTurns = parsePositiveInt(args[++i], "--autonomous-max-turns", result);
			}
		} else if (arg === "--autonomous-max-tokens") {
			result.autonomous = true;
			if (hasRequiredOptionValue(args, i, arg, result)) {
				result.autonomousMaxTokens = parsePositiveInt(args[++i], "--autonomous-max-tokens", result);
			}
		} else if (arg === "--autonomous-timeout-ms") {
			result.autonomous = true;
			if (hasRequiredOptionValue(args, i, arg, result)) {
				result.autonomousTimeoutMs = parsePositiveInt(args[++i], "--autonomous-timeout-ms", result);
			}
		} else if (arg === "--list-models") {
			// Check if next arg is a search pattern (not a flag or file arg)
			if (i + 1 < args.length && !args[i + 1].startsWith("-") && !args[i + 1].startsWith("@")) {
				result.listModels = args[++i];
			} else {
				result.listModels = true;
			}
		} else if (arg === "--verbose") {
			result.verbose = true;
		} else if (arg === "--offline") {
			result.offline = true;
		} else if (arg.startsWith("@")) {
			result.fileArgs.push(arg.slice(1)); // Remove @ prefix
		} else if (arg.startsWith("--")) {
			const eqIndex = arg.indexOf("=");
			if (eqIndex !== -1) {
				result.unknownFlags.set(arg.slice(2, eqIndex), arg.slice(eqIndex + 1));
			} else {
				const flagName = arg.slice(2);
				const next = args[i + 1];
				if (next !== undefined && !next.startsWith("-") && !next.startsWith("@")) {
					result.unknownFlags.set(flagName, next);
					i++;
				} else {
					result.unknownFlags.set(flagName, true);
				}
			}
		} else if (arg.startsWith("-") && !arg.startsWith("--")) {
			result.diagnostics.push({ type: "error", message: `Unknown option: ${arg}` });
		} else if (!arg.startsWith("-")) {
			result.messages.push(arg);
		}
	}

	return result;
}

export function printHelp(extensionFlags?: ExtensionFlag[]): void {
	const extensionFlagsText =
		extensionFlags && extensionFlags.length > 0
			? `\n${chalk.bold("Extension CLI Flags:")}\n${extensionFlags
					.map((flag) => {
						const value = flag.type === "string" ? " <value>" : "";
						const description = flag.description ?? `Registered by ${flag.extensionPath}`;
						return `  --${flag.name}${value}`.padEnd(30) + description;
					})
					.join("\n")}\n`
			: "";
	console.log(`${chalk.bold(APP_NAME)} - AI coding assistant with an ipython tool

${chalk.bold("Usage:")}
  ${APP_NAME} [options] [@files...] [messages...]   Open a new chat (press left to reach the agents view)

${chalk.bold("Commands:")}
  ${APP_NAME} agents                    Open the agents view (alias: manage)
  ${APP_NAME} install <source> [-l]     Install extension source and add to settings
  ${APP_NAME} remove <source> [-l]      Remove extension source from settings
  ${APP_NAME} uninstall <source> [-l]   Alias for remove
  ${APP_NAME} update [source|self|${APP_NAME}]   Update ${APP_NAME} and installed extensions
  ${APP_NAME} list                      List installed extensions from settings
  ${APP_NAME} config                    Open TUI to enable/disable package resources
  ${APP_NAME} daemon [name]             Start daemon if needed, create a session, and attach
  ${APP_NAME} <command> --help          Show help for install/remove/uninstall/update/list/daemon

${chalk.bold("Options:")}
  --provider <name>              Provider name (default: google)
  --model <pattern>              Model pattern or ID (supports "provider/id" and optional ":<thinking>")
  --api-key <key>                API key (defaults to env vars)
  --cwd <dir>                    Working directory for the session
  --system-prompt <text>         System prompt (default: coding assistant prompt)
  --append-system-prompt <text>  Append text or file contents to the system prompt (can be used multiple times)
  --mode <mode>                  Output mode: text (default), json, rpc, or daemon
  --daemon-socket <path>         Socket path for daemon mode
  --print, -p                    Non-interactive mode: process prompt and exit
  --continue, -c                 Continue previous session
  --resume, -r [path|id]         Resume specific session, or browse when omitted
  --fork <path|id>               Fork specific session file or partial UUID into a new session
  --session-dir <dir>            Directory for session storage and lookup
  --no-session                   Don't save session (ephemeral)
  --models <patterns>            Comma-separated model patterns for Ctrl+P cycling
                                 Supports globs (anthropic/*, *sonnet*) and fuzzy matching
  --no-tools, -nt                Disable all tools by default (built-in and extension)
  --no-builtin-tools, -nbt       Disable built-in tools by default but keep extension/custom tools enabled
  --tools, -t <tools>            Comma-separated allowlist of tool names to enable
                                 Applies to built-in, extension, and custom tools
  --thinking <level>             Set thinking level: off, minimal, low, medium, high, xhigh, max
  --plan                         Start in plan mode (file edits are blocked until toggled off)
  --extension, -e <path>         Load an extension file (can be used multiple times)
  --no-extensions, -ne           Disable extension discovery (explicit -e paths still work)
  --skill <path>                 Load a skill file or directory (can be used multiple times)
  --no-skills, -ns               Disable skills discovery and loading
  --prompt-template <path>       Load a prompt template file or directory (can be used multiple times)
  --no-prompt-templates, -np     Disable prompt template discovery and loading
  --theme <path>                 Load a theme file or directory (can be used multiple times)
  --no-themes                    Disable theme discovery and loading
  --no-context-files, -nc        Disable AGENTS.md and CLAUDE.md discovery and loading
  --autonomous                   Continue autonomously until host-observable terminal evidence exists
  --autonomous-gate <command>    Run a command before autonomous mode may finish (repeatable)
  --autonomous-gate-retries <n>  Max autonomous retries per failed gate (default: 3)
  --autonomous-gate-timeout-ms <n> Timeout per autonomous gate command in milliseconds
  --autonomous-max-continuations <n> Max autonomous follow-up messages (default: 3)
  --autonomous-max-turns <n>     Max assistant turns while autonomous mode is active (default: 12)
  --autonomous-max-tokens <n>    Max tokens while autonomous mode is active (default: 80000)
  --autonomous-timeout-ms <n>    Max autonomous wall-clock time in milliseconds (default: 1800000)
  --export <file>                Export session file to HTML and exit
  --list-models [search]         List available models (with optional fuzzy search)
  --verbose                      Force verbose startup (overrides quietStartup setting)
  --offline                      Disable startup network operations (same as PI_OFFLINE=1)
  --help, -h                     Show this help
  --version, -v                  Show version number
  --                             End of options; treat all following args as messages

Extensions can register additional flags.${extensionFlagsText}

${chalk.bold("Examples:")}
  # Interactive mode
  ${APP_NAME}

  # Interactive mode with initial prompt
  ${APP_NAME} "List all .ts files in src/"

  # Include files in initial message
  ${APP_NAME} @prompt.md @image.png "What color is the sky?"

  # Non-interactive mode (process and exit)
  ${APP_NAME} -p "List all .ts files in src/"

  # Multiple messages (interactive)
  ${APP_NAME} "Read package.json" "What dependencies do we have?"

  # Prompt that starts with a dash (use -- to end option parsing)
  ${APP_NAME} -- "- You are given a state dictionary..."

  # Continue previous session
  ${APP_NAME} --continue "What did we discuss?"

  # Use different model
  ${APP_NAME} --provider openai --model gpt-4o-mini "Help me refactor this code"

  # Use model with provider prefix (no --provider needed)
  ${APP_NAME} --model openai/gpt-4o "Help me refactor this code"

  # Use model with thinking level shorthand
  ${APP_NAME} --model sonnet:high "Solve this complex problem"

  # Limit the session to specific models
  ${APP_NAME} --models claude-sonnet,claude-haiku,gpt-4o

  # Limit to a specific provider with glob pattern
  ${APP_NAME} --models "github-copilot/*"

  # Scope models with fixed thinking levels
  ${APP_NAME} --models sonnet:high,haiku:low

  # Start with a specific thinking level
  ${APP_NAME} --thinking high "Solve this complex problem"

  # Export a session file to HTML
  ${APP_NAME} --export ~/${CONFIG_DIR_NAME}/sessions/session.jsonl
  ${APP_NAME} --export session.jsonl output.html

  # Start and control active sessions
  ${APP_NAME} daemon --socket /tmp/prime-agent.sock --model openai/gpt-4o-mini scratch
  ${APP_NAME} daemon --socket /tmp/prime-agent.sock list
  ${APP_NAME} daemon --socket /tmp/prime-agent.sock prompt <session> "Say hello"

${chalk.bold("Environment Variables:")}
  ANTHROPIC_API_KEY                - Anthropic Claude API key
  ANTHROPIC_OAUTH_TOKEN            - Anthropic OAuth token (alternative to API key)
  OPENAI_API_KEY                   - OpenAI GPT API key
  PRIME_API_KEY                    - Prime Inference API key
  AZURE_OPENAI_API_KEY             - Azure OpenAI API key
  AZURE_OPENAI_BASE_URL            - Azure OpenAI/Cognitive Services base URL (e.g. https://{resource}.openai.azure.com)
  AZURE_OPENAI_RESOURCE_NAME       - Azure OpenAI resource name (alternative to base URL)
  AZURE_OPENAI_API_VERSION         - Azure OpenAI API version (default: v1)
  AZURE_OPENAI_DEPLOYMENT_NAME_MAP - Azure OpenAI model=deployment map (comma-separated)
  DEEPSEEK_API_KEY                 - DeepSeek API key
  GEMINI_API_KEY                   - Google Gemini API key
  GROQ_API_KEY                     - Groq API key
  CEREBRAS_API_KEY                 - Cerebras API key
  XAI_API_KEY                      - xAI Grok API key
  FIREWORKS_API_KEY                - Fireworks API key
  OPENROUTER_API_KEY               - OpenRouter API key
  AI_GATEWAY_API_KEY               - Vercel AI Gateway API key
  ZAI_API_KEY                      - ZAI API key
  MISTRAL_API_KEY                  - Mistral API key
  MINIMAX_API_KEY                  - MiniMax API key
  MOONSHOT_API_KEY                 - Moonshot AI API key
  OPENCODE_API_KEY                 - OpenCode Zen/OpenCode Go API key
  KIMI_API_KEY                     - Kimi For Coding API key
  CLOUDFLARE_API_KEY               - Cloudflare API token (Workers AI and AI Gateway)
  CLOUDFLARE_ACCOUNT_ID            - Cloudflare account id (required for both)
  CLOUDFLARE_GATEWAY_ID            - Cloudflare AI Gateway slug (required for AI Gateway)
  XIAOMI_API_KEY                   - Xiaomi MiMo API key (api.xiaomimimo.com billing)
  XIAOMI_TOKEN_PLAN_CN_API_KEY     - Xiaomi MiMo Token Plan API key (China region)
  XIAOMI_TOKEN_PLAN_AMS_API_KEY    - Xiaomi MiMo Token Plan API key (Amsterdam region)
  XIAOMI_TOKEN_PLAN_SGP_API_KEY    - Xiaomi MiMo Token Plan API key (Singapore region)
  AWS_PROFILE                      - AWS profile for Amazon Bedrock
  AWS_ACCESS_KEY_ID                - AWS access key for Amazon Bedrock
  AWS_SECRET_ACCESS_KEY            - AWS secret key for Amazon Bedrock
  AWS_BEARER_TOKEN_BEDROCK         - Bedrock API key (bearer token)
  AWS_REGION                       - AWS region for Amazon Bedrock (e.g., us-east-1)
  ${ENV_AGENT_DIR.padEnd(32)} - Config directory (default: ~/${CONFIG_DIR_NAME})
  ${ENV_SESSION_DIR.padEnd(32)} - Session root directory (overridden by --session-dir)
  PI_PACKAGE_DIR                   - Override package directory (for Nix/Guix store paths)
  PI_OFFLINE                       - Disable startup network operations when set to 1/true/yes
  PRIME_AGENT_DOWNLOAD_BASE_URL    - Override the Prime Agent release manifest and tarball base URL
  PI_SHARE_VIEWER_URL              - Base URL for /share command (default: https://pi.dev/session/)
  SERPER_API_KEY                   - Overrides the stored Serper key for the websearch skill (use /login to store one)
  PRIME_AGENT_WEBSEARCH_TIMEOUT    - websearch HTTP timeout in seconds (default: 45)
  PRIME_AGENT_WEBSEARCH_NUM_RESULTS - websearch organic results to return (default: 5)

${chalk.bold("Built-in Tool Names:")}
  ipython - Execute Python in a persistent IPython kernel
`);
}

function hasRequiredOptionValue(args: string[], index: number, flag: string, result: Args): boolean {
	const next = args[index + 1];
	if (next === undefined || next.startsWith("--")) {
		result.diagnostics.push({ type: "error", message: `${flag} requires a value` });
		return false;
	}
	return true;
}

function parsePositiveInt(value: string, flag: string, result: Args): number | undefined {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		result.diagnostics.push({ type: "error", message: `${flag} must be a positive integer` });
		return undefined;
	}
	return parsed;
}
