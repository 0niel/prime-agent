import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export interface AgentSessionRuntimeConfig {
	cwd?: string;
	agentDir?: string;
	sessionDir?: string;
	provider?: string;
	model?: string;
	apiKey?: string;
	systemPrompt?: string;
	appendSystemPrompt?: string[];
	thinking?: ThinkingLevel;
	models?: string[];
	tools?: string[];
	noTools?: boolean;
	noBuiltinTools?: boolean;
	extensions?: string[];
	noExtensions?: boolean;
	skills?: string[];
	noSkills?: boolean;
	promptTemplates?: string[];
	noPromptTemplates?: boolean;
	themes?: string[];
	noThemes?: boolean;
	noContextFiles?: boolean;
	extensionFlagValues?: Record<string, boolean | string>;
}

export function mergeAgentSessionRuntimeConfig(
	base: AgentSessionRuntimeConfig,
	override?: AgentSessionRuntimeConfig,
): AgentSessionRuntimeConfig {
	if (!override) {
		return cloneAgentSessionRuntimeConfig(base);
	}
	return {
		cwd: override.cwd ?? base.cwd,
		agentDir: override.agentDir ?? base.agentDir,
		sessionDir: override.sessionDir ?? base.sessionDir,
		provider: override.provider ?? base.provider,
		model: override.model ?? base.model,
		apiKey: override.apiKey ?? base.apiKey,
		systemPrompt: override.systemPrompt ?? base.systemPrompt,
		appendSystemPrompt: cloneArray(override.appendSystemPrompt ?? base.appendSystemPrompt),
		thinking: override.thinking ?? base.thinking,
		models: cloneArray(override.models ?? base.models),
		tools: cloneArray(override.tools ?? base.tools),
		noTools: override.noTools ?? base.noTools,
		noBuiltinTools: override.noBuiltinTools ?? base.noBuiltinTools,
		extensions: cloneArray(override.extensions ?? base.extensions),
		noExtensions: override.noExtensions ?? base.noExtensions,
		skills: cloneArray(override.skills ?? base.skills),
		noSkills: override.noSkills ?? base.noSkills,
		promptTemplates: cloneArray(override.promptTemplates ?? base.promptTemplates),
		noPromptTemplates: override.noPromptTemplates ?? base.noPromptTemplates,
		themes: cloneArray(override.themes ?? base.themes),
		noThemes: override.noThemes ?? base.noThemes,
		noContextFiles: override.noContextFiles ?? base.noContextFiles,
		extensionFlagValues:
			base.extensionFlagValues || override.extensionFlagValues
				? { ...(base.extensionFlagValues ?? {}), ...(override.extensionFlagValues ?? {}) }
				: undefined,
	};
}

function cloneAgentSessionRuntimeConfig(config: AgentSessionRuntimeConfig): AgentSessionRuntimeConfig {
	return {
		...config,
		appendSystemPrompt: cloneArray(config.appendSystemPrompt),
		models: cloneArray(config.models),
		tools: cloneArray(config.tools),
		extensions: cloneArray(config.extensions),
		skills: cloneArray(config.skills),
		promptTemplates: cloneArray(config.promptTemplates),
		themes: cloneArray(config.themes),
		extensionFlagValues: config.extensionFlagValues ? { ...config.extensionFlagValues } : undefined,
	};
}

function cloneArray<T>(value: T[] | undefined): T[] | undefined {
	return value ? [...value] : undefined;
}
