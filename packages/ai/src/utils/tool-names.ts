const MAX_TOOL_NAME_LENGTH = 64;

export function normalizeToolName(name: string): string {
	const normalized = name.replace(/[^a-zA-Z0-9_-]+/g, "_") || "tool";
	return normalized.slice(0, MAX_TOOL_NAME_LENGTH);
}
