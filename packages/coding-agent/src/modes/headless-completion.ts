import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSession } from "../core/agent-session.js";
import {
	type AgentAutonomousStatus,
	autonomousLimitReason,
	buildAutonomousGateFailureContinuation,
} from "../core/autonomous.js";

export function latestAutonomousGateAttempt(status: AgentAutonomousStatus): number {
	return Math.max(status.lastGateFailure?.attempt ?? 0, 0, ...Object.values(status.gateAttempts));
}

function shouldContinueAutonomousGates(status: AgentAutonomousStatus): boolean {
	return (
		status.enabled &&
		status.gates.commands.length > 0 &&
		!!status.lastGateFailure &&
		latestAutonomousGateAttempt(status) <= status.gates.maxRetries &&
		!autonomousLimitReason(status)
	);
}

function autonomousProgressKey(status: AgentAutonomousStatus): string {
	return [
		latestAutonomousGateAttempt(status),
		status.continuationsUsed,
		status.turnsUsed,
		status.tokensUsed,
		status.lastGateFailure?.exitText ?? "",
	].join(":");
}

export async function waitForHeadlessCompletion(session: AgentSession): Promise<AgentAutonomousStatus> {
	let lastPromptedProgressKey: string | undefined;
	let repeatedProgressPrompts = 0;
	while (true) {
		await session.agent.waitForIdle();
		const status = session.getAutonomousStatus();
		if (!shouldContinueAutonomousGates(status) || !status.lastGateFailure) {
			return status;
		}
		const progressKey = autonomousProgressKey(status);
		if (progressKey === lastPromptedProgressKey) {
			repeatedProgressPrompts++;
		} else {
			repeatedProgressPrompts = 0;
			lastPromptedProgressKey = progressKey;
		}
		if (repeatedProgressPrompts > 0) {
			await new Promise((resolve) => setTimeout(resolve, Math.min(1000, repeatedProgressPrompts * 50)));
		}
		session.recordHostAutonomousContinuation();
		await session.prompt(
			buildAutonomousGateFailureContinuation(
				{ ...status.lastGateFailure, attempt: latestAutonomousGateAttempt(status) },
				status.gates.maxRetries,
			),
			{
				streamingBehavior: "followUp",
				internalPrompt: true,
				suppressAutonomousContinuation: true,
			},
		);
		await session.agent.waitForIdle();
		await session.refreshAutonomousGates();
		const lastMessage = session.state.messages.at(-1);
		if (lastMessage?.role === "assistant") {
			const assistantMessage = lastMessage as AssistantMessage;
			if (assistantMessage.stopReason === "error" || assistantMessage.stopReason === "aborted") {
				const postErrorStatus = session.getAutonomousStatus();
				if (shouldContinueAutonomousGates(postErrorStatus) && postErrorStatus.lastGateFailure) {
					continue;
				}
				return postErrorStatus;
			}
		}
	}
}
