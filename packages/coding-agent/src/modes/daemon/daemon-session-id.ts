const DISPLAY_ID_LENGTH = 12;
const HEX_ID_PATTERN = /^[0-9a-f]+$/;

export function formatSessionDisplayId(id: string): string {
	const normalized = normalizeSessionId(id);
	if (!normalized) {
		return id.length > DISPLAY_ID_LENGTH ? id.slice(-DISPLAY_ID_LENGTH) : id;
	}
	return normalized.length > DISPLAY_ID_LENGTH ? normalized.slice(-DISPLAY_ID_LENGTH) : normalized;
}

export function matchesSessionIdSuffix(candidate: string, suffix: string): boolean {
	const normalizedCandidate = normalizeSessionId(candidate);
	const normalizedSuffix = normalizeSessionId(suffix);
	return !!normalizedCandidate && !!normalizedSuffix && normalizedCandidate.endsWith(normalizedSuffix);
}

function normalizeSessionId(id: string): string | undefined {
	const normalized = id.replaceAll("-", "").toLowerCase();
	return normalized && HEX_ID_PATTERN.test(normalized) ? normalized : undefined;
}
