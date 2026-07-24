/** Counts in-flight mutating commands so update-restart preparation can wait for them to drain. */
export class MutationDrainLatch {
	private active = 0;
	private readonly waiters = new Set<() => void>();

	begin(): void {
		this.active++;
	}

	end(): void {
		this.active--;
		for (const resolve of this.waiters) resolve();
		this.waiters.clear();
	}

	async waitForDrain(remaining: number, signal: AbortSignal, abortMessage: string): Promise<void> {
		while (this.active > remaining) {
			if (signal.aborted) throw new Error(abortMessage);
			await new Promise<void>((resolve, reject) => {
				const settle = (error?: Error) => {
					this.waiters.delete(onDrained);
					signal.removeEventListener("abort", onAbort);
					if (error) reject(error);
					else resolve();
				};
				const onDrained = () => settle();
				const onAbort = () => settle(new Error(abortMessage));
				this.waiters.add(onDrained);
				signal.addEventListener("abort", onAbort, { once: true });
			});
		}
	}
}
