import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createMcpProjectTrustAuthority,
	type McpProjectTrustAuthority,
	type McpProjectTrustAuthorization,
	type McpProjectTrustBinding,
} from "../src/core/mcp/project-trust-authority.js";

const tempDirectories: string[] = [];

function tempDirectory(): string {
	const directory = mkdtempSync(join(realpathSync.native(tmpdir()), "project-trust-"));
	tempDirectories.push(directory);
	return directory;
}

function authorize(authority: McpProjectTrustAuthority, directory: string): McpProjectTrustAuthorization {
	return authority.authorizeProjectDirectory(directory);
}

function grantedBinding(result: McpProjectTrustAuthorization): McpProjectTrustBinding {
	expect(result.kind).toBe("granted");
	if (result.kind === "denied") {
		throw new Error("Expected granted authorization");
	}
	return result.binding;
}

afterEach(() => {
	for (const directory of tempDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("MCP project trust authority", () => {
	it("denies by default when no global user allowlist grants the project", () => {
		const project = tempDirectory();
		const authority = createMcpProjectTrustAuthority({ revision: "global-1", allowedProjectDirectories: [] });

		expect(authorize(authority, project)).toEqual({ kind: "denied" });
	});

	it("grants an exact directory only from the explicit global allowlist", () => {
		const project = tempDirectory();
		const authority = createMcpProjectTrustAuthority({ revision: "global-1", allowedProjectDirectories: [project] });
		const binding = grantedBinding(authorize(authority, project));

		expect(Object.isFrozen(binding)).toBe(true);
		expect(Object.keys(binding)).toEqual([]);
		expect(authorize(authority, join(project, "child"))).toEqual({ kind: "denied" });
	});

	it("does not accept a project-owned override as an authority input", () => {
		const project = tempDirectory();
		// A project config can claim anything; this module neither receives nor reads it.
		mkdirSync(join(project, ".prime", "agent"), { recursive: true });
		const projectSettingsClaim = { mcpProjectTrust: { allow: [project] } };
		const authority = createMcpProjectTrustAuthority({
			revision: "global-1",
			allowedProjectDirectories: [],
			...({ projectSettingsClaim } as object),
		});

		expect(projectSettingsClaim.mcpProjectTrust.allow).toEqual([project]);
		expect(authorize(authority, project)).toEqual({ kind: "denied" });
	});

	it("rejects symlink and lexical aliases even when their target is explicitly allowed", () => {
		const parent = tempDirectory();
		const project = join(parent, "project");
		const link = join(parent, "project-link");
		mkdirSync(project);
		symlinkSync(project, link, "dir");
		const authority = createMcpProjectTrustAuthority({ revision: "global-1", allowedProjectDirectories: [project] });

		expect(authorize(authority, link)).toEqual({ kind: "denied" });
		expect(authorize(authority, `${project}/.`)).toEqual({ kind: "denied" });
		expect(authorize(authority, project)).toMatchObject({ kind: "granted" });
	});

	it("fail-closes the entire snapshot when its explicit allowlist contains an alias", () => {
		const parent = tempDirectory();
		const project = join(parent, "project");
		const link = join(parent, "project-link");
		mkdirSync(project);
		symlinkSync(project, link, "dir");
		const authority = createMcpProjectTrustAuthority({
			revision: "global-1",
			allowedProjectDirectories: [project, link],
		});

		expect(authorize(authority, project)).toEqual({ kind: "denied" });
	});

	it("pins the supplied policy and rejects a replaced directory after a grant", () => {
		const parent = tempDirectory();
		const project = join(parent, "project");
		const replacement = join(parent, "replacement");
		mkdirSync(project);
		const globalPolicy = { revision: "global-1", allowedProjectDirectories: [project] };
		const authority = createMcpProjectTrustAuthority(globalPolicy);
		grantedBinding(authorize(authority, project));

		globalPolicy.revision = "mutated";
		globalPolicy.allowedProjectDirectories.length = 0;
		// The grant is opaque; a later authorization proves the original
		// revision/allowlist was copied rather than read again from mutable input.
		expect(authorize(authority, project).kind).toBe("granted");
		mkdirSync(replacement);
		rmSync(project, { recursive: true });
		renameSync(replacement, project);
		expect(authorize(authority, project)).toEqual({ kind: "denied" });
	});
});
