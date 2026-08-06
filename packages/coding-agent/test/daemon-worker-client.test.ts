import { describe, expect, it, vi } from "vitest";
import { DAEMON_PROTOCOL_INFO } from "../src/modes/daemon/daemon-protocol.js";
import { DaemonWorkerClient } from "../src/modes/daemon/daemon-worker-client.js";

type StubWorkerClient = {
	request(command: unknown): Promise<unknown>;
	close(): void;
	hello: unknown;
	socket: { destroyed: boolean };
	channel: { send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
};

function stubWorkerClient(schemaRevision: number): StubWorkerClient {
	const client = new DaemonWorkerClient("/tmp/worker.sock") as unknown as StubWorkerClient;
	client.hello = {
		type: "daemon_hello",
		socketPath: "/tmp/worker.sock",
		protocol: DAEMON_PROTOCOL_INFO,
		appVersion: "test",
		clientId: "worker",
		schemaRevision,
		serverCapabilities: ["queue_item_mutation"],
	};
	client.socket = { destroyed: false, destroy: vi.fn() } as unknown as { destroyed: boolean };
	client.channel = { send: vi.fn(async () => {}), close: vi.fn() };
	return client;
}

describe("DaemonWorkerClient compatibility", () => {
	it.each([
		[15, false],
		[16, true],
	] as const)("gates revisioned queue mutation against schema %i", async (schemaRevision, sent) => {
		const client = stubWorkerClient(schemaRevision);
		const request = client.request({
			type: "mutate_queue_item",
			activeSessionId: "active",
			actionId: "action",
			expectedRevision: 1,
			mutation: { type: "delete" },
		});
		if (sent) {
			await vi.waitFor(() => expect(client.channel.send).toHaveBeenCalledOnce());
			// No response is injected; avoid awaiting the pending request.
			client.close();
			await expect(request).rejects.toThrow("closed");
		} else {
			await expect(request).rejects.toThrow("queue_item_mutation");
			expect(client.channel.send).not.toHaveBeenCalled();
		}
	});
});
