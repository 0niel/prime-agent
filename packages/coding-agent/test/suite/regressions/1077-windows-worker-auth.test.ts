import { describe, expect, it, vi } from "vitest";
import { workerAuthenticationAttemptTimeoutMs } from "../../../src/modes/daemon/daemon-supervisor.js";
import { createProcessStartIdCache } from "../../../src/modes/daemon/daemon-supervisor-ownership.js";

describe("#1077 Windows worker authentication", () => {
	it("reuses process start IDs across authentication retries", () => {
		let now = 100;
		const lookup = vi.fn((pid: number) => `win:${pid}`);
		const cachedLookup = createProcessStartIdCache(lookup, 5000, () => now);

		expect(cachedLookup(42)).toBe("win:42");
		now = 5099;
		expect(cachedLookup(42)).toBe("win:42");
		expect(lookup).toHaveBeenCalledTimes(1);

		now = 5100;
		expect(cachedLookup(42)).toBe("win:42");
		expect(lookup).toHaveBeenCalledTimes(2);
	});

	it("starts the cache TTL after a slow Windows process lookup completes", () => {
		let now = 100;
		const lookup = vi.fn(() => {
			now += 20_000;
			return undefined;
		});
		const cachedLookup = createProcessStartIdCache(lookup, 5000, () => now);

		expect(cachedLookup(7)).toBeUndefined();
		now += 4999;
		expect(cachedLookup(7)).toBeUndefined();
		expect(lookup).toHaveBeenCalledTimes(1);
	});

	it("allows a Windows authentication attempt to use the remaining connection budget", () => {
		expect(workerAuthenticationAttemptTimeoutMs(30_000, "win32", 5000)).toBe(25_000);
		expect(workerAuthenticationAttemptTimeoutMs(30_000, "linux", 5000)).toBe(1000);
		expect(workerAuthenticationAttemptTimeoutMs(30_000, "win32", 30_000)).toBe(1);
	});
});
