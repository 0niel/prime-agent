import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	runCatalog: vi.fn(),
	startDaemon: vi.fn(),
	startOwnedWorker: vi.fn(),
}));

vi.mock("../../../src/modes/daemon/daemon-catalog-process.js", () => ({
	isDaemonCatalogProcess: () => true,
	runDaemonCatalogProcess: mocks.runCatalog,
}));

vi.mock("../../../src/cli/daemon-launch.js", () => ({
	maybeStartDaemonEarly: mocks.startDaemon,
}));

vi.mock("../../../src/cli/owned-session-worker.js", () => ({
	closeOwnedSessionWorkerOwnerWatch: vi.fn(),
	installOwnedSessionWorkerOwnerWatch: vi.fn(),
	isOwnedSessionWorkerProcess: () => false,
	maybeRunOwnedSessionWorkerFrontend: mocks.startOwnedWorker,
}));

vi.mock("../../../src/config.js", () => ({ APP_NAME: "prime-agent-test" }));

import { runCli } from "../../../src/cli-main.js";

describe("#1077 Windows daemon catalog startup", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.runCatalog.mockResolvedValue(undefined);
	});

	it("dispatches the catalog role before normal CLI startup", async () => {
		await runCli();

		expect(mocks.runCatalog).toHaveBeenCalledOnce();
		expect(mocks.startDaemon).not.toHaveBeenCalled();
		expect(mocks.startOwnedWorker).not.toHaveBeenCalled();
	});
});
