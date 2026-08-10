const MIN_INSPECTION_CHARS = 8_192;
const INSPECTION_INTERVAL_CHARS = 512;
const MAX_BUFFER_CHARS = 16_384;
const MAX_PERIOD_CHARS = 128;
const MIN_PERIOD_REPETITIONS = 32;
const MIN_TRIGRAMS = 512;
const MAX_TRIGRAM_NOVELTY = 0.2;

export const REPETITION_GUARD_DISABLED_ENV = "PRIME_AGENT_NO_REPETITION_GUARD";

export type RepetitionGuardReason = "periodic_tail" | "novelty_stall";

export interface RepetitionGuardMatch {
	reason: RepetitionGuardReason;
	inspectedCharacters: number;
	periodCharacters?: number;
	trigramNovelty?: number;
}

/**
 * Bounds degenerate reasoning streams while retaining a deliberately large
 * inspection floor to avoid interrupting short, legitimate repetitions.
 */
export class RepetitionGuard {
	private buffer = "";
	private receivedCharacters = 0;
	private lastInspectionAt = 0;

	push(delta: string): RepetitionGuardMatch | undefined {
		this.receivedCharacters += delta.length;
		this.buffer = (this.buffer + delta).slice(-MAX_BUFFER_CHARS);
		if (this.buffer.length < MIN_INSPECTION_CHARS) return undefined;
		if (this.receivedCharacters - this.lastInspectionAt < INSPECTION_INTERVAL_CHARS) return undefined;
		this.lastInspectionAt = this.receivedCharacters;

		const periodic = detectPeriodicTail(this.buffer.slice(-MIN_INSPECTION_CHARS));
		if (periodic !== undefined) {
			return {
				reason: "periodic_tail",
				inspectedCharacters: this.receivedCharacters,
				periodCharacters: periodic,
			};
		}

		const novelty = trigramNovelty(this.buffer);
		if (novelty !== undefined && novelty <= MAX_TRIGRAM_NOVELTY) {
			return {
				reason: "novelty_stall",
				inspectedCharacters: this.receivedCharacters,
				trigramNovelty: novelty,
			};
		}
		return undefined;
	}
}

function detectPeriodicTail(tail: string): number | undefined {
	// Ignore formatting-only padding. A content loop has many word tokens.
	if ((tail.match(/[\p{L}\p{N}_]+/gu) ?? []).length < MIN_PERIOD_REPETITIONS) return undefined;

	const failure = new Uint16Array(tail.length);
	for (let i = 1; i < tail.length; i++) {
		let matched = failure[i - 1];
		while (matched > 0 && tail[i] !== tail[matched]) matched = failure[matched - 1];
		if (tail[i] === tail[matched]) matched++;
		failure[i] = matched;
	}

	const period = tail.length - failure[tail.length - 1];
	if (period > MAX_PERIOD_CHARS || Math.floor(tail.length / period) < MIN_PERIOD_REPETITIONS) return undefined;
	for (let i = period; i < tail.length; i++) {
		if (tail[i] !== tail[i - period]) return undefined;
	}
	return period;
}

function trigramNovelty(text: string): number | undefined {
	const words = text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
	const trigramCount = words.length - 2;
	if (trigramCount < MIN_TRIGRAMS) return undefined;

	const distinct = new Set<string>();
	for (let i = 0; i < trigramCount; i++) {
		distinct.add(`${words[i]}\u0000${words[i + 1]}\u0000${words[i + 2]}`);
	}
	return distinct.size / trigramCount;
}
