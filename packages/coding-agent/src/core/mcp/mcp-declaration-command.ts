import type { SettingsManager } from "../settings-manager.js";
import {
	addMcpDeclaration,
	parseMcpDeclarationDocument,
	previewMcpProbe,
	removeMcpDeclaration,
	type McpDeclarationScope,
} from "./mcp-declarations.js";
import { redactMcpDeclaration, redactMcpDeclarationDocument } from "./mcp-redaction.js";
import {
	runMcpDeclarationProbe,
	type McpDeclarationProbeOptions,
	type McpProbeTransport,
} from "./mcp-probe.js";
import {
	requireProjectMcpDeclarationAdmission,
	type ProjectMcpDeclarationAdmission,
} from "./mcp-project-trust.js";

export type McpDeclarationCommand =
	| { kind: "list"; scope: McpDeclarationScope }
	| { kind: "inspect"; scope: McpDeclarationScope; name: string }
	| { kind: "preview"; scope: McpDeclarationScope; name: string }
	| { kind: "test"; scope: McpDeclarationScope; name: string }
	| { kind: "add"; scope: McpDeclarationScope; name: string; url: string }
	| { kind: "enable" | "disable" | "remove"; scope: McpDeclarationScope; name: string };

function usage(): never {
	throw new Error("Usage: prime-agent mcp <list|inspect|preview|test|add|enable|disable|remove> ... [--project]");
}

function parseScope(words: string[]): { words: string[]; scope: McpDeclarationScope } {
	const projectIndexes = words.reduce<number[]>((indexes, word, index) => (word === "--project" ? [...indexes, index] : indexes), []);
	if (projectIndexes.length > 1 || (projectIndexes.length === 1 && projectIndexes[0] !== words.length - 1)) usage();
	return { words: words.filter((word) => word !== "--project"), scope: projectIndexes.length ? "project" : "user" };
}

/** Parses declarative commands only. Parsing has no storage, auth, or I/O side effects. */
export function parseMcpDeclarationCommand(args: string[]): McpDeclarationCommand {
	const { words, scope } = parseScope(args);
	const [kind, ...operands] = words;
	if (kind === "list" && operands.length === 0) return { kind, scope };
	if (
		(kind === "inspect" || kind === "preview" || kind === "test" || kind === "enable" || kind === "disable" || kind === "remove") &&
		operands.length === 1
	) {
		return { kind, scope, name: operands[0]! };
	}
	if (kind === "add" && operands.length === 2) return { kind, scope, name: operands[0]!, url: operands[1]! };
	usage();
}

function documentForScope(
	settings: SettingsManager,
	scope: McpDeclarationScope,
	admission: ProjectMcpDeclarationAdmission | undefined,
) {
	// Validate before every project settings read; this is intentionally before
	// getMcpDeclarationDocument so denied state is inert without a project read.
	if (scope === "project") requireProjectMcpDeclarationAdmission(admission);
	return settings.getMcpDeclarationDocument(scope);
}

function writeDocumentForScope(
	settings: SettingsManager,
	scope: McpDeclarationScope,
	document: ReturnType<typeof parseMcpDeclarationDocument>,
	admission: ProjectMcpDeclarationAdmission | undefined,
): void {
	// Validate again at each privileged mutation; no raw path is available here.
	if (scope === "project") requireProjectMcpDeclarationAdmission(admission);
	settings.setMcpDeclarationDocument(scope, document);
}

export interface McpDeclarationCommandOptions extends McpDeclarationProbeOptions {
	/** Deliberately supplied only by a local caller or test; no default transport exists. */
	probeTransport?: McpProbeTransport;
}

export async function executeMcpDeclarationCommand(
	command: McpDeclarationCommand,
	settings: SettingsManager,
	admission?: ProjectMcpDeclarationAdmission,
	options: McpDeclarationCommandOptions = {},
): Promise<unknown> {
	const document = documentForScope(settings, command.scope, admission);
	if (command.kind === "list") return redactMcpDeclarationDocument(document);
	const declaration = document.servers[command.name];
	if (command.kind === "add") {
		const next = addMcpDeclaration(document, command.name, command.url);
		writeDocumentForScope(settings, command.scope, next, admission);
		return redactMcpDeclaration(next.servers[command.name]!);
	}
	if (!declaration) throw new Error("No MCP declaration has that name.");
	if (command.kind === "inspect") return redactMcpDeclaration(declaration);
	if (command.kind === "preview") return previewMcpProbe(redactMcpDeclaration(declaration));
	if (command.kind === "test") {
		if (!options.probeTransport) {
			throw new Error("MCP probe is unavailable in this command context.");
		}
		return runMcpDeclarationProbe(declaration, options.probeTransport, {
			offline: options.offline,
			// A project probe receives a grant only after a fresh Core validation.
			trusted: command.scope === "user" || requireProjectMcpDeclarationAdmission(admission) !== undefined,
			timeoutMs: options.timeoutMs,
		});
	}
	if (command.kind === "remove") {
		writeDocumentForScope(settings, command.scope, removeMcpDeclaration(document, command.name), admission);
		return { removed: command.name };
	}
	const next = parseMcpDeclarationDocument({
		version: 1,
		servers: { ...document.servers, [command.name]: { ...declaration, enabled: command.kind === "enable" } },
	});
	writeDocumentForScope(settings, command.scope, next, admission);
	return redactMcpDeclaration(next.servers[command.name]!);
}
