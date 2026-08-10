import { describe, expect, it, vi } from "vitest";
import { workerAuthenticationAttemptTimeoutMs } from "../../../src/modes/daemon/daemon-supervisor.js";
import { processIdentityMatches } from "../../../src/modes/daemon/daemon-supervisor-ownership.js";

describe("#1077 Windows worker authentication", () => {
	it("rejects a PID reused between immediate identity checks", () => {
		const getStartId = vi.fn().mockReturnValueOnce("win:old").mockReturnValueOnce("win:reused");
		const probe = { isAlive: vi.fn(() => true), getStartId };
		const identity = { pid: 42, processStartId: "win:old" };

		expect(processIdentityMatches(identity, false, probe)).toBe(true);
		expect(processIdentityMatches(identity, false, probe)).toBe(false);
		expect(getStartId).toHaveBeenCalledTimes(2);
	});

	it("checks process liveness fresh before querying its start ID", () => {
		const isAlive = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false);
		const getStartId = vi.fn(() => "win:old");
		const probe = { isAlive, getStartId };
		const identity = { pid: 42, processStartId: "win:old" };

		expect(processIdentityMatches(identity, false, probe)).toBe(true);
		expect(processIdentityMatches(identity, false, probe)).toBe(false);
		expect(isAlive).toHaveBeenCalledTimes(2);
		expect(getStartId).toHaveBeenCalledTimes(1);
	});

	it("allows a Windows authentication attempt to use the remaining connection budget", () => {
		expect(workerAuthenticationAttemptTimeoutMs(30_000, "win32", 5000)).toBe(25_000);
		expect(workerAuthenticationAttemptTimeoutMs(30_000, "linux", 5000)).toBe(1000);
		expect(workerAuthenticationAttemptTimeoutMs(30_000, "win32", 30_000)).toBe(1);
	});
});
