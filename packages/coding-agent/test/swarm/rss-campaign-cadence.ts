export const MAX_RSS_SAMPLE_GAP_MS = 50;
export const DEFAULT_RSS_REQUESTED_PERIOD_MS = 25;

export interface CadenceValidation {
	maxObservedGapMs: number | null;
	valid: boolean;
}

/** Validates the unmodified monotonic timestamps emitted after each collection. */
export function validateRssSampleCadence(timestamps: readonly number[]): CadenceValidation {
	if (timestamps.length < 2) return { maxObservedGapMs: null, valid: false };
	const gaps = timestamps.slice(1).map((timestamp, index) => timestamp - timestamps[index]!);
	const maxObservedGapMs = Math.max(...gaps);
	return { maxObservedGapMs, valid: maxObservedGapMs <= MAX_RSS_SAMPLE_GAP_MS };
}
