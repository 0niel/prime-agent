import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.js";

const fixturePath = fileURLToPath(new URL("./fixtures/rpc-lifecycle-process.mjs", import.meta.url));

function createClient(args: string[] = []): RpcClient {
	return new RpcClient({ cliPath: fixturePath, args });
}

describe("RpcClient lifecycle", () => {
	const clients: RpcClient[] = [];

	afterEach(async () => {
		vi.useRealTimers();
		await Promise.all(clients.map((client) => client.stop()));
		clients.length = 0;
	});

	it("rejects pending requests and clears their timers when stopped", async () => {
		const client = createClient();
		clients.push(client);
		await client.start();
		vi.useFakeTimers();

		const request = client.getState();
		await vi.advanceTimersByTimeAsync(0);
		const stop = client.stop();

		await expect(request).rejects.toThrow("RPC client stopped before the operation completed");
		await stop;
		expect(vi.getTimerCount()).toBe(0);
	});

	it("rejects lifecycle waiters when stopped", async () => {
		const client = createClient();
		clients.push(client);
		await client.start();
		vi.useFakeTimers();

		const idle = client.waitForIdle();
		const events = client.collectEvents();
		const stop = client.stop();

		await expect(idle).rejects.toThrow("RPC client stopped before the operation completed");
		await expect(events).rejects.toThrow("RPC client stopped before the operation completed");
		await stop;
		expect(vi.getTimerCount()).toBe(0);
	});

	it("cleans up event collection when a prompt is rejected during stop", async () => {
		const client = createClient();
		clients.push(client);
		await client.start();
		vi.useFakeTimers();

		const stop = client.stop();
		await expect(client.promptAndWait("too late")).rejects.toThrow("Client is stopping");
		await stop;
		expect(vi.getTimerCount()).toBe(0);
	});

	it("shares concurrent stop calls and prevents restart until termination completes", async () => {
		const client = createClient(["--ignore-sigterm"]);
		clients.push(client);
		await client.start();

		const firstStop = client.stop();
		const secondStop = client.stop();
		await expect(client.getState()).rejects.toThrow("Client is stopping");
		await expect(client.start()).rejects.toThrow("Client already started");
		await Promise.all([firstStop, secondStop]);

		await expect(client.start()).resolves.toBeUndefined();
	});

	it("rejects pending requests and clears their timers when the process exits", async () => {
		const client = createClient(["--exit-on-input"]);
		clients.push(client);
		await client.start();
		vi.useFakeTimers();

		const request = client.getState();
		await vi.advanceTimersByTimeAsync(0);

		await expect(request).rejects.toThrow("Agent process exited with code 23");
		expect(vi.getTimerCount()).toBe(0);
		await expect(client.getState()).rejects.toThrow("Client not started");
	});

	it("delivers a final response before cleaning up an exited process", async () => {
		const client = createClient(["--respond-then-exit"]);
		clients.push(client);
		await client.start();

		await expect(client.getState()).resolves.toMatchObject({ sessionId: "final" });
	});

	it("rejects a new request safely while final output is draining", async () => {
		const client = createClient(["--respond-then-exit"]);
		clients.push(client);
		await client.start();

		await expect(client.getState()).resolves.toMatchObject({ sessionId: "final" });
		await expect(client.getState()).rejects.toThrow(
			/Client not started|Agent process input error|Agent process exited/,
		);
	});

	it("rejects pending requests and clears their timers when the process errors", async () => {
		vi.useFakeTimers();
		const client = new RpcClient({ cliPath: fixturePath, env: { PATH: "" } });
		clients.push(client);

		const start = client.start();
		const startError = expect(start).rejects.toThrow("Agent process error");
		const request = client.getState();

		await expect(request).rejects.toThrow("Agent process error");
		await vi.advanceTimersByTimeAsync(100);
		await startError;
		expect(vi.getTimerCount()).toBe(0);
	});

	it("stops safely while the process is failing to spawn", async () => {
		const client = new RpcClient({ cliPath: fixturePath, env: { PATH: "" } });
		clients.push(client);

		const start = client.start();
		const startError = expect(start).rejects.toThrow("Agent process error");

		await expect(client.stop()).resolves.toBeUndefined();
		await startError;
	});
});
