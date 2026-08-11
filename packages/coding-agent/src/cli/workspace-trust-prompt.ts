/**
 * Startup workspace-trust consent prompt.
 *
 * Runs before session services are created. If the effective working directory
 * commits project-scoped configuration that would execute code (extensions,
 * shell prefixes, MCP servers, Python skills, ...) and the workspace is not
 * trusted yet, interactive startup asks for consent once. All other modes
 * stay silent here: createAgentSessionServices emits a warning diagnostic
 * listing what was disabled, which every client surface prints. Trusting
 * writes the shared trust store, which daemon workers and future sessions
 * read at service creation.
 */

import chalk from "chalk";
import { canonicalizeWorkspacePath, detectProjectScopedConfig, WorkspaceTrustStore } from "../core/workspace-trust.js";
import { promptYesNo } from "./daemon-stop-confirm.js";

export interface WorkspaceTrustGateOptions {
	cwd: string;
	agentDir: string;
	/** Only interactive startup may block on a prompt. */
	interactive: boolean;
}

/** Canonical paths already prompted for in this process (accept or decline). */
const promptedThisProcess = new Set<string>();

export async function gateWorkspaceTrustOnStartup(options: WorkspaceTrustGateOptions): Promise<void> {
	const { cwd, agentDir } = options;
	const canonical = canonicalizeWorkspacePath(cwd);
	if (promptedThisProcess.has(canonical)) {
		return;
	}
	const store = WorkspaceTrustStore.create(agentDir);
	if (store.isTrusted(cwd)) {
		return;
	}
	if (!options.interactive || !process.stdin.isTTY || !process.stdout.isTTY) {
		return;
	}
	const findings = detectProjectScopedConfig(cwd);
	if (findings.length === 0) {
		return;
	}
	promptedThisProcess.add(canonical);

	console.error(chalk.yellow("This workspace contains project-scoped configuration:"));
	for (const finding of findings) {
		console.error(chalk.yellow(`  - ${finding.summary}`));
		console.error(chalk.dim(`    ${finding.path}`));
	}
	console.error(chalk.dim("Only trust repositories you have inspected. Untrusted workspaces run without the above."));
	const trusted = await promptYesNo("Trust this workspace and enable its project-scoped configuration?");
	if (trusted) {
		store.trust(cwd);
		console.error(chalk.dim(`Trusted ${cwd} (stored in trusted-workspaces.json).`));
	}
}
