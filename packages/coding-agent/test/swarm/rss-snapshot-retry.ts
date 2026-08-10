/** The retry budget is deliberately shorter than the 50 ms sample-gap contract. */
export const RSS_SCAN_RETRY_WINDOW_MS = 20;
export const RSS_SCAN_RETRY_DELAY_MS = 2;

export interface RetryClock {
	now(): number;
	pause(milliseconds: number): Promise<void>;
}

/**
 * Retries only unavailable snapshots within one monotonic convergence window.
 * A returned value is accepted only if the collector itself declared it
 * coherent; this helper never converts an unavailable result into an empty one.
 */
export async function retryUnavailableSnapshot<T>(
	collect: (attempt: number) => Promise<T>,
	isUnavailable: (snapshot: T) => boolean,
	clock: RetryClock,
	windowMs = RSS_SCAN_RETRY_WINDOW_MS,
	delayMs = RSS_SCAN_RETRY_DELAY_MS,
): Promise<T> {
	const deadline = clock.now() + windowMs;
	let attempt = 0;
	let lastUnavailable: T | undefined;
	for (;;) {
		// Do not begin a further full scan once the convergence budget expired.
		if (attempt > 0 && clock.now() >= deadline) return lastUnavailable!;
		const snapshot = await collect(attempt);
		attempt += 1;
		if (!isUnavailable(snapshot)) return snapshot;
		lastUnavailable = snapshot;
		const remaining = deadline - clock.now();
		if (remaining <= 0) return snapshot;
		await clock.pause(Math.min(delayMs, remaining));
	}
}
