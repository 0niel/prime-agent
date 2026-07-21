import chalk from "chalk";
import { getPendingDaemonUpdateRestartRecoveryKind } from "./daemon-update-manifest.js";
import { buildDaemonUpdateRestartReport, launchDaemonUpdateRestartCoordinator } from "./daemon-update-restart.js";

export async function recoverPendingDaemonUpdateRestart(
	socketPath: string,
	agentDir: string,
	cwd: string,
): Promise<void> {
	const recoveryKind = getPendingDaemonUpdateRestartRecoveryKind(socketPath, agentDir);
	if (!recoveryKind) {
		return;
	}
	try {
		const status = await launchDaemonUpdateRestartCoordinator({
			socketPath,
			agentDir,
			cwd,
			retryOnly: recoveryKind === "retry",
		});
		const report = buildDaemonUpdateRestartReport(status);
		for (const message of report.info) {
			console.log(chalk.green(message));
		}
		for (const warning of report.warnings) {
			console.error(chalk.yellow(`Warning: ${warning}`));
		}
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(chalk.yellow(`Warning: could not recover sessions from the interrupted update (${message}).`));
	}
}
