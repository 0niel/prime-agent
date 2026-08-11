/**
 * Startup workspace-trust gate.
 *
 * Runs before session services are created. If the effective working directory
 * commits project-scoped configuration that would execute code (extensions,
 * shell prefixes, MCP servers, Python skills, ...) and the workspace is not
 * trusted yet, interactive startup asks for consent; every other mode skips
 * the project configuration and prints a notice. Trusting writes the shared
 * trust store, which daemon workers and future sessions read at service
 * creation.
 */

import chalk from "chalk";
import { APP_NAME } from "../config.js";
import {
	detectProjectScopedConfig,
	type ProjectScopedConfigFinding,
	WorkspaceTrustStore,
} from "../core/workspace-trust.js";
import { promptYesNo } from "./daemon-stop-confirm.js";

export interface WorkspaceTrustGateOptions {
	cwd: string;
	agentDir: string;
	/** Only interactive startup may block on a prompt. */
	interactive: boolean;
}

function printUntrustedNotice(findings: ProjectScopedConfigFinding[]): void {
	console.error(
		chalk.yellow(
			`Workspace not trusted; disabled project-scoped configuration: ${findings
				.map((finding) => finding.summary)
				.join("; ")}. Run \`${APP_NAME} trust\` to enable it.`,
		),
	);
}

export async function gateWorkspaceTrustOnStartup(options: WorkspaceTrustGateOptions): Promise<void> {
	const { cwd, agentDir } = options;
	const store = WorkspaceTrustStore.create(agentDir);
	if (store.isTrusted(cwd)) {
		return;
	}
	const findings = detectProjectScopedConfig(cwd);
	if (findings.length === 0) {
		return;
	}

	if (!options.interactive || !process.stdin.isTTY || !process.stdout.isTTY) {
		printUntrustedNotice(findings);
		return;
	}

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
		return;
	}
	printUntrustedNotice(findings);
}
