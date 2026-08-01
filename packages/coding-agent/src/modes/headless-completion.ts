import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSession } from "../core/agent-session.js";
import {
	type AgentAutonomousStatus,
	autonomousLimitReason,
	buildAutonomousGateFailureContinuation,
} from "../core/autonomous.js";
import {
	COMPACTION_OUTCOME_CUSTOM_TYPE,
	type CompactionOutcomeMessage,
	isCompactionOutcomeMessage,
	isSessionSlashCommandResultMessage,
	type SessionSlashCommandResultMessage,
} from "../core/messages.js";

export function latestAutonomousGateAttempt(status: AgentAutonomousStatus): number {
	return Math.max(status.lastGateFailure?.attempt ?? 0, 0, ...Object.values(status.gateAttempts));
}

export type HeadlessTerminalResultMessage = AssistantMessage | SessionSlashCommandResultMessage;

export interface HeadlessTerminalResult {
	primary?: HeadlessTerminalResultMessage;
	compactionOutcomes: CompactionOutcomeMessage[];
}

export function selectHeadlessTerminalResult(messages: readonly AgentMessage[]): HeadlessTerminalResult {
	let index = messages.length - 1;
	const compactionOutcomes: CompactionOutcomeMessage[] = [];
	while (index >= 0) {
		const message = messages[index];
		if (isCompactionOutcomeMessage(message)) {
			compactionOutcomes.unshift(message);
			index--;
			continue;
		}
		// A corrupt outcome is still part of the terminal outcome suffix. Skip it
		// without letting it hide earlier valid outcomes or their failure status.
		if (message.role === "custom" && message.customType === COMPACTION_OUTCOME_CUSTOM_TYPE) {
			index--;
			continue;
		}
		break;
	}
	const precedingMessage = messages[index];
	const primary =
		precedingMessage?.role === "assistant" || isSessionSlashCommandResultMessage(precedingMessage)
			? precedingMessage
			: undefined;
	return { primary, compactionOutcomes };
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
	let limitReported = false;
	// The host loop evaluates limits itself; in-session evaluation may have already
	// reported the same stop, so AgentSession drops the duplicate.
	const reportLimit = (current: AgentAutonomousStatus): void => {
		if (limitReported || !current.enabled) return;
		const reason = autonomousLimitReason(current);
		if (!reason) return;
		limitReported = true;
		session.reportAutonomousLimitReached(reason);
	};
	while (true) {
		await session.agent.waitForIdle();
		const status = session.getAutonomousStatus();
		if (!shouldContinueAutonomousGates(status) || !status.lastGateFailure) {
			reportLimit(status);
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
		const { primary } = selectHeadlessTerminalResult(session.state.messages);
		if (primary?.role === "assistant") {
			if (primary.stopReason === "error" || primary.stopReason === "aborted") {
				const postErrorStatus = session.getAutonomousStatus();
				if (shouldContinueAutonomousGates(postErrorStatus) && postErrorStatus.lastGateFailure) {
					continue;
				}
				reportLimit(postErrorStatus);
				return postErrorStatus;
			}
		}
	}
}
