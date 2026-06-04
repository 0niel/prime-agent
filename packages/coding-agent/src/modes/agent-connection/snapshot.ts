import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentSession } from "../../core/agent-session.js";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.js";
import type {
	AgentConnectionModel,
	AgentConnectionResourceSnapshot,
	AgentConnectionSlashCommand,
	AgentConnectionState,
} from "./types.js";

export function createAgentConnectionState(
	runtime: AgentSessionRuntime,
	activeSessionId?: string,
): AgentConnectionState {
	const session = runtime.session;
	const sessionManager = session.sessionManager;
	return {
		activeSessionId,
		cwd: sessionManager.getCwd(),
		model: toConnectionModel(session.model),
		thinkingLevel: session.thinkingLevel,
		availableThinkingLevels: session.getAvailableThinkingLevels(),
		isStreaming: session.isStreaming,
		isCompacting: session.isCompacting,
		retryAttempt: session.retryAttempt,
		steeringMode: session.steeringMode,
		followUpMode: session.followUpMode,
		sessionFile: session.sessionFile,
		sessionId: session.sessionId,
		sessionName: session.sessionName,
		sessionDir: sessionManager.getSessionDir(),
		leafId: sessionManager.getLeafId(),
		autoCompactionEnabled: session.autoCompactionEnabled,
		messageCount: session.messages.length,
		pendingMessageCount: session.pendingMessageCount,
		compactionCount: sessionManager.getEntries().filter((entry) => entry.type === "compaction").length,
		goal: session.goalState,
		scopedModels: session.scopedModels.map((scoped) => ({
			model: toConnectionModel(scoped.model),
			thinkingLevel: scoped.thinkingLevel,
		})),
		activeToolNames: session.getActiveToolNames(),
		contextUsage: session.getContextUsage(),
	};
}

export function createAgentConnectionCommands(session: AgentSession): AgentConnectionSlashCommand[] {
	return [
		...session.extensionRunner.getRegisteredCommands().map((entry) => ({
			name: entry.invocationName,
			registeredName: entry.name,
			description: entry.description,
			source: "extension" as const,
			sourceInfo: entry.sourceInfo,
		})),
		...session.promptTemplates.map((entry) => ({
			name: entry.name,
			description: entry.description,
			argumentHint: entry.argumentHint,
			source: "prompt" as const,
			sourceInfo: entry.sourceInfo,
		})),
		...session.resourceLoader.getSkills().skills.map((entry) => ({
			name: `skill:${entry.name}`,
			description: entry.description,
			source: "skill" as const,
			sourceInfo: entry.sourceInfo,
		})),
	];
}

export function createAgentConnectionResourceSnapshot(session: AgentSession): AgentConnectionResourceSnapshot {
	const skillsResult = session.resourceLoader.getSkills();
	const promptsResult = session.resourceLoader.getPrompts();
	const themesResult = session.resourceLoader.getThemes();
	const extensionsResult = session.resourceLoader.getExtensions();

	return {
		contextFiles: session.resourceLoader.getAgentsFiles().agentsFiles.map((entry) => ({
			path: entry.path,
		})),
		skills: skillsResult.skills.map((skill) => ({
			name: skill.name,
			description: skill.description,
			filePath: skill.filePath,
			sourceInfo: skill.sourceInfo,
		})),
		prompts: promptsResult.prompts.map((prompt) => ({
			name: prompt.name,
			description: prompt.description,
			argumentHint: prompt.argumentHint,
			filePath: prompt.filePath,
			sourceInfo: prompt.sourceInfo,
		})),
		extensions: extensionsResult.extensions.map((extension) => ({
			path: extension.path,
			sourceInfo: extension.sourceInfo,
		})),
		themes: themesResult.themes.map((loadedTheme) => ({
			name: loadedTheme.name,
			sourcePath: loadedTheme.sourcePath,
			sourceInfo: loadedTheme.sourceInfo,
		})),
		diagnostics: {
			skills: skillsResult.diagnostics,
			prompts: promptsResult.diagnostics,
			extensions: extensionsResult.errors.map((error) => ({
				type: "error",
				message: error.error,
				path: error.path,
			})),
			themes: themesResult.diagnostics,
		},
	};
}

export function toConnectionModel(model: Model<Api>): AgentConnectionModel;
export function toConnectionModel(model: Model<Api> | undefined): AgentConnectionModel | undefined;
export function toConnectionModel(model: Model<Api> | undefined): AgentConnectionModel | undefined {
	return model;
}
