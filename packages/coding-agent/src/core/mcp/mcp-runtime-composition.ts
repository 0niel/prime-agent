import type { Settings } from "../settings-manager.js";
import { admitProjectMcpDeclarations, type ProjectMcpDeclarationAdmission } from "./mcp-project-trust.js";
import { createMcpProjectTrustAuthority } from "./project-trust-authority.js";

/**
 * Global-only project declaration admission. This is deliberately usable before
 * SettingsManager.create(), so denial/malformed policy cannot trigger a project
 * settings read. The return value is opaque and has no policy/path authority.
 */
export function composeMcpRuntimeProjectAdmission(
	globalSettings: Pick<Settings, "mcpProjectTrustPolicy">,
	workingDirectory: string,
): ProjectMcpDeclarationAdmission | undefined {
	const policy = globalSettings.mcpProjectTrustPolicy;
	const authority = createMcpProjectTrustAuthority({
		revision: typeof policy?.revision === "string" ? policy.revision : "",
		allowedProjectDirectories: Array.isArray(policy?.allowedProjectDirectories) && policy.allowedProjectDirectories.every((path) => typeof path === "string") ? policy.allowedProjectDirectories : [],
	});
	return admitProjectMcpDeclarations(workingDirectory, authority);
}
