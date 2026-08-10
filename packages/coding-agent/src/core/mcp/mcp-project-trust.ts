import type { McpDeclarationDocument } from "./mcp-declarations.js";

/**
 * C05 must supply this capability after its authority API and pinned revision
 * are admitted. M01 intentionally has no constructor, fallback, persistence,
 * or ambient trust heuristic for it.
 */
export interface C05ProjectMcpTrustCapability {
	allowsProjectMcpDeclarations(projectDirectory: string): boolean;
}

export interface ProjectMcpDeclarations {
	document: McpDeclarationDocument;
	effective: boolean;
}

/**
 * Project declarations are inert unless a C05 capability affirmatively grants
 * this exact project. This boundary starts no transport and reads no secrets.
 */
export function resolveProjectMcpDeclarations(
	projectDirectory: string,
	document: McpDeclarationDocument,
	capability: C05ProjectMcpTrustCapability | undefined,
): ProjectMcpDeclarations {
	if (!capability || !capability.allowsProjectMcpDeclarations(projectDirectory)) {
		return { document: { version: 1, servers: {} }, effective: false };
	}
	return { document: structuredClone(document), effective: true };
}
