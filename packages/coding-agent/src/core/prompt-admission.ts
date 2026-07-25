/**
 * Shared prompt-admission cancellation primitives used by the session core,
 * the daemon, and the supervisor. Admission cancellation is uncertain and
 * non-retryable by design: cancelling only wins while the original request is
 * still waiting, so every layer must reject with the same typed error and
 * observe the underlying work to avoid unhandled rejections.
 */
export class PromptAdmissionCancelledError extends Error {
	constructor() {
		super("Prompt admission was cancelled.");
		this.name = "PromptAdmissionCancelledError";
	}
}

export function throwIfPromptAdmissionCancelled(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new PromptAdmissionCancelledError();
}

/**
 * Await `promise` unless `signal` aborts first. A pre-aborted signal rejects
 * immediately but still observes the supplied work's eventual rejection so a
 * cancelled admission never produces an unhandled rejection.
 */
export function waitForPromptAdmission<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) {
		void promise.catch(() => {});
		return Promise.reject(new PromptAdmissionCancelledError());
	}
	return new Promise<T>((resolve, reject) => {
		const cleanup = () => signal.removeEventListener("abort", onAbort);
		const onAbort = () => {
			cleanup();
			reject(new PromptAdmissionCancelledError());
		};
		signal.addEventListener("abort", onAbort, { once: true });
		// Close the listener-registration race before observing the awaited work.
		if (signal.aborted) return onAbort();
		promise.then(
			(value) => {
				cleanup();
				resolve(value);
			},
			(error: unknown) => {
				cleanup();
				reject(error);
			},
		);
	});
}
