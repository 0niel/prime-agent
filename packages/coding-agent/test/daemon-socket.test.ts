import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultDaemonSocketPath } from "../src/modes/daemon/daemon-socket.js";

describe("defaultDaemonSocketPath", () => {
	it("uses a fixed Windows named pipe path", () => {
		if (process.platform !== "win32") {
			return;
		}

		expect(defaultDaemonSocketPath()).toBe("\\\\.\\pipe\\prime-agent-daemon");
	});

	it("uses a per-user Unix socket directory", () => {
		if (process.platform === "win32") {
			return;
		}

		const suffix = typeof process.getuid === "function" ? String(process.getuid()) : "user";
		const socketPath = defaultDaemonSocketPath();

		expect(dirname(socketPath)).toBe(join(tmpdir(), `prime-agent-${suffix}`));
		expect(basename(socketPath)).toBe("daemon.sock");
	});
});
