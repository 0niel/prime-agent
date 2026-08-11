import type {
	McpProjectTrustAuthority,
	McpProjectTrustAuthorization,
	McpProjectTrustBinding,
	McpProjectTrustBindingValidation,
} from "./project-trust-authority.js";
import { isMcpProjectTrustAuthority } from "./project-trust-authority.js";
import { emptyMcpDeclarationDocument, type McpDeclarationDocument } from "./mcp-declarations.js";

/**
 * A branded, empty capability. Its authority/binding pair never appears on the
 * object: membership is checked before that pair is ever dereferenced.
 */
export interface ProjectMcpDeclarationAdmission {}

interface AdmissionPair {
	readonly authority: McpProjectTrustAuthority;
	readonly binding: McpProjectTrustBinding;
}

const admissions = new WeakSet<object>();
const admissionPairs = new WeakMap<object, AdmissionPair>();
const DENIED: McpProjectTrustBindingValidation = Object.freeze({ kind: "denied" });
const GRANTED: McpProjectTrustBindingValidation = Object.freeze({ kind: "granted" });

export function admitProjectMcpDeclarations(
	rawProjectDirectory: string,
	authority: McpProjectTrustAuthority | undefined,
): ProjectMcpDeclarationAdmission | undefined {
	if (!isMcpProjectTrustAuthority(authority)) return undefined;
	let authorization: McpProjectTrustAuthorization;
	try {
		authorization = authority.authorizeProjectDirectory(rawProjectDirectory);
	} catch {
		return undefined;
	}
	if (authorization.kind !== "granted") return undefined;

	const admission = Object.freeze(Object.create(null));
	admissions.add(admission);
	admissionPairs.set(admission, Object.freeze({ authority, binding: authorization.binding }));
	return admission as ProjectMcpDeclarationAdmission;
}

/**
 * This membership test intentionally precedes the WeakMap read. A forged
 * envelope cannot cause a supplied authority, binding, or accessor to be
 * consulted.
 */
export function validateProjectMcpDeclarationAdmission(
	admission: ProjectMcpDeclarationAdmission | undefined,
): McpProjectTrustBindingValidation {
	if (typeof admission !== "object" || admission === null || !admissions.has(admission)) return DENIED;
	const pair = admissionPairs.get(admission);
	if (!pair) return DENIED;
	try {
		return pair.authority.validateBinding(pair.binding).kind === "granted" ? GRANTED : DENIED;
	} catch {
		return DENIED;
	}
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
 * A denied, missing, stale, foreign, or forged capability makes declarations
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
