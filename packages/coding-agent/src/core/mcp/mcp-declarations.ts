/**
 * M01's declarative, credential-free MCP record. This module has no transport,
 * authentication, or process-launch dependency.
 */
export const MCP_DECLARATION_VERSION = 1 as const;
export const MCP_DECLARATION_NAME = /^[a-z][a-z0-9-]{0,62}$/;

export interface McpDeclaration {
	name: string;
	url: string;
	enabled: boolean;
}

export interface McpDeclarationDocument {
	version: typeof MCP_DECLARATION_VERSION;
	servers: Record<string, McpDeclaration>;
}

export type McpDeclarationScope = "user" | "project";

function fail(message: string): never {
	// Deliberately never include supplied configuration values in errors: callers
	// may have provided an accidentally credential-bearing URL or field.
	throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeMcpDeclarationName(value: unknown): string {
	if (typeof value !== "string" || !MCP_DECLARATION_NAME.test(value)) {
		fail("MCP declaration names must start with a lowercase letter and contain lowercase letters, digits, or hyphens.");
	}
	return value;
}

/** Canonical, non-credential-bearing Streamable HTTP endpoint identity. */
export function normalizeMcpDeclarationUrl(value: unknown): string {
	if (typeof value !== "string" || /[\s\\]/.test(value)) {
		fail("MCP declaration URLs must be a single HTTP(S) URL.");
	}
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		fail("MCP declaration URLs must be a valid HTTP(S) URL.");
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		fail("MCP declaration URLs must use HTTP or HTTPS.");
	}
	if (url.username || url.password || url.search || url.hash) {
		fail("MCP declaration URLs must not contain credentials, query strings, or fragments.");
	}
	return url.toString();
}

function requireExactKeys(record: Record<string, unknown>, keys: readonly string[]): void {
	for (const key of Object.keys(record)) {
		if (!keys.includes(key)) fail("MCP declarations only permit name, url, and enabled fields.");
	}
}

export function parseMcpDeclaration(value: unknown, expectedName?: string): McpDeclaration {
	if (!isRecord(value)) fail("MCP declaration must be an object.");
	requireExactKeys(value, ["name", "url", "enabled"]);
	const name = normalizeMcpDeclarationName(value.name);
	if (expectedName !== undefined && name !== expectedName) {
		fail("MCP declaration name must match its settings key.");
	}
	if (typeof value.enabled !== "boolean") fail("MCP declaration enabled must be a boolean.");
	return { name, url: normalizeMcpDeclarationUrl(value.url), enabled: value.enabled };
}

export function emptyMcpDeclarationDocument(): McpDeclarationDocument {
	return { version: MCP_DECLARATION_VERSION, servers: {} };
}

export function parseMcpDeclarationDocument(value: unknown): McpDeclarationDocument {
	if (value === undefined) return emptyMcpDeclarationDocument();
	if (!isRecord(value)) fail("MCP declaration settings must be an object.");
	requireExactKeys(value, ["version", "servers"]);
	if (value.version !== MCP_DECLARATION_VERSION || !isRecord(value.servers)) {
		fail("MCP declaration settings use an unsupported format.");
	}
	const servers: Record<string, McpDeclaration> = {};
	const urls = new Set<string>();
	for (const [key, declaration] of Object.entries(value.servers)) {
		const name = normalizeMcpDeclarationName(key);
		const parsed = parseMcpDeclaration(declaration, name);
		if (urls.has(parsed.url)) fail("MCP declarations must not repeat an endpoint URL.");
		urls.add(parsed.url);
		servers[name] = parsed;
	}
	return { version: MCP_DECLARATION_VERSION, servers };
}

export function addMcpDeclaration(
	document: McpDeclarationDocument,
	name: unknown,
	url: unknown,
): McpDeclarationDocument {
	const parsedName = normalizeMcpDeclarationName(name);
	const parsedUrl = normalizeMcpDeclarationUrl(url);
	if (document.servers[parsedName]) fail("An MCP declaration with that name already exists.");
	if (Object.values(document.servers).some((server) => server.url === parsedUrl)) {
		fail("An MCP declaration with that endpoint URL already exists.");
	}
	return {
		version: MCP_DECLARATION_VERSION,
		servers: { ...document.servers, [parsedName]: { name: parsedName, url: parsedUrl, enabled: true } },
	};
}

export function removeMcpDeclaration(document: McpDeclarationDocument, name: unknown): McpDeclarationDocument {
	const parsedName = normalizeMcpDeclarationName(name);
	if (!document.servers[parsedName]) fail("No MCP declaration has that name.");
	const { [parsedName]: _removed, ...servers } = document.servers;
	return { version: MCP_DECLARATION_VERSION, servers };
}

/** A static probe request description. Creating it never performs I/O. */
export function previewMcpProbe(declaration: McpDeclaration): {
	url: string;
	method: "POST";
	redirect: "error";
	requestKind: "mcp-initialize";
} {
	return { url: declaration.url, method: "POST", redirect: "error", requestKind: "mcp-initialize" };
}
