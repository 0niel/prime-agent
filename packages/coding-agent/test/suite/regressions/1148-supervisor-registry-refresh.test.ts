import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireDaemonSupervisorOwnership } from "../../../src/modes/daemon/daemon-supervisor-ownership.js";

const tempDirs: string[] = [];

afterEach(() => {
	vi.useRealTimers();
	for (const directory of tempDirs.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "prime-regression-1148-"));
	tempDirs.push(root);
	const agentDir = join(root, "agent");
	const descriptorDir = join(root, "workers");
	const registryDir = join(root, "registry");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(descriptorDir, { recursive: true });
	return {
		root,
		agentDir,
		descriptorDir,
		registryDir,
		socketPath: join(root, "daemon.sock"),
	};
}

function ownerDirectory(registryDir: string, generation: string): string {
	return join(registryDir, `${generation}.owner`);
}

describe("#1148 supervisor registry pruning recovery", () => {
	it("restores its missing registry entry while retaining the original token", async () => {
		const paths = fixture();
		const generation = "original-generation";
		const ownership = await acquireDaemonSupervisorOwnership({
			...paths,
			generation,
			appVersion: "test",
		});
		try {
			const directory = ownerDirectory(paths.registryDir, generation);
			rmSync(directory, { recursive: true, force: true });

			await expect(ownership.assertCurrent()).resolves.toBeUndefined();

			const restored = JSON.parse(readFileSync(join(directory, "owner.json"), "utf8")) as { token: string };
			expect(restored.token).toBe(ownership.record.token);
			expect(existsSync(join(directory, "scope.json"))).toBe(true);
		} finally {
			await ownership.release();
		}
	});

	it("refreshes and restores an idle owner's entry without waiting for a command", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		const paths = fixture();
		const generation = "idle-generation";
		const ownership = await acquireDaemonSupervisorOwnership({
			...paths,
			generation,
			appVersion: "test",
		});
		try {
			const directory = ownerDirectory(paths.registryDir, generation);
			rmSync(directory, { recursive: true, force: true });

			await vi.advanceTimersByTimeAsync(60_000);
			const deadline = Date.now() + 1000;
			while (!existsSync(join(directory, "owner.json")) && Date.now() < deadline) {
				await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
			}

			expect(existsSync(join(directory, "owner.json"))).toBe(true);
			expect(existsSync(join(directory, "scope.json"))).toBe(true);
		} finally {
			await ownership.release();
		}
	});

	it("fails closed when a live replacement claims the same socket and descriptors", async () => {
		const paths = fixture();
		const original = await acquireDaemonSupervisorOwnership({
			...paths,
			generation: "displaced-generation",
			appVersion: "test",
		});
		rmSync(ownerDirectory(paths.registryDir, original.record.generation), { recursive: true, force: true });
		const replacement = await acquireDaemonSupervisorOwnership({
			...paths,
			generation: "replacement-generation",
			appVersion: "test",
		});
		try {
			await expect(original.assertCurrent()).rejects.toMatchObject({ code: "supervisor_generation_stale" });
		} finally {
			await replacement.release();
			await original.release();
		}
	});
});
