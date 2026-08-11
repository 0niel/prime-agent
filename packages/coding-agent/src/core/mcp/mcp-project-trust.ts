import type {
	McpProjectTrustAuthority,
	McpProjectTrustAuthorization,
	McpProjectTrustBinding,
	McpProjectTrustBindingValidation,
} from "../index.js";
import { emptyMcpDeclarationDocument, type McpDeclarationDocument } from "./mcp-declarations.js";

/**
 * The composition boundary makes one authorization decision for a raw project
 * path. All later privileged uses retain only the opaque Core binding.
 */
export interface ProjectMcpDeclarationAdmission {
	readonly authority: McpProjectTrustAuthority;
	readonly binding: McpProjectTrustBinding;
}

export function admitProjectMcpDeclarations(
	rawProjectDirectory: string,
	authority: McpProjectTrustAuthority | undefined,
): ProjectMcpDeclarationAdmission | undefined {
	if (!authority) return undefined;
	const authorization: McpProjectTrustAuthorization = authority.authorizeProjectDirectory(rawProjectDirectory);
	if (authorization.kind !== "granted") return undefined;
	return Object.freeze({ authority, binding: authorization.binding });
}

/** Validate the retained Core binding without consulting a raw path or policy. */
export function validateProjectMcpDeclarationAdmission(
	admission: ProjectMcpDeclarationAdmission | undefined,
): McpProjectTrustBindingValidation {
	return admission?.authority.validateBinding(admission.binding) ?? { kind: "denied" };
}

export function requireProjectMcpDeclarationAdmission(
	admission: ProjectMcpDeclarationAdmission | undefined,
): ProjectMcpDeclarationAdmission {
	if (validateProjectMcpDeclarationAdmission(admission).kind !== "granted") {
		throw new Error("Project MCP declarations are unavailable.");
	}
	return admission!;
}

export interface ProjectMcpDeclarations {
	document: McpDeclarationDocument;
	effective: boolean;
}

/**
 * A denied, missing, stale, foreign, or forged binding makes declarations
 * inert. The caller must validate before any project settings read or write.
 */
export function resolveProjectMcpDeclarations(
	document: McpDeclarationDocument,
	admission: ProjectMcpDeclarationAdmission | undefined,
): ProjectMcpDeclarations {
	if (validateProjectMcpDeclarationAdmission(admission).kind !== "granted") {
		return { document: emptyMcpDeclarationDocument(), effective: false };
	}
	return { document: structuredClone(document), effective: true };
}
