import { describe, expect, it } from "vitest";
import { VERSION } from "../src/config.js";
import { type McpProbeSession, type McpProbeTransport, runMcpDeclarationProbe } from "../src/core/mcp/mcp-probe.js";

const declaration = { name: "catalog", url: "https://catalog.test/mcp", enabled: true };

function fakeTransport(calls: string[], overrides: Partial<McpProbeSession> = {}): McpProbeTransport {
	return {
		async open({ url }) {
			calls.push(`open:${url}`);
			return {
				async request(request) {
					calls.push(request.method);
				},
				async notification(notification) {
					calls.push(notification.method);
				},
				async close() {
					calls.push("close");
				},
				...overrides,
			};
		},
	};
}

describe("M01 injected MCP probe", () => {
	it("initializes, notifies, then lists tools and always closes the injected session", async () => {
		const calls: string[] = [];
		await expect(runMcpDeclarationProbe(declaration, fakeTransport(calls), { trusted: true })).resolves.toEqual({
			initialized: true,
			toolsListed: true,
		});
		expect(calls).toEqual([
			"open:https://catalog.test/mcp",
			"initialize",
			"notifications/initialized",
			"tools/list",
			"close",
		]);
		expect(calls.join(" ")).not.toContain("tools/call");
	});

	it("sends the exact shipped version in initialize clientInfo", async () => {
		let initialize: unknown;
		const transport = fakeTransport([], {
			async request(request) {
				if (request.method === "initialize") initialize = request;
			},
		});
		await runMcpDeclarationProbe(declaration, transport, { trusted: true });
		expect(initialize).toMatchObject({
			method: "initialize",
			params: { clientInfo: { name: "Prime Agent", version: VERSION } },
		});
	});

	it.each([
		["disabled", { ...declaration, enabled: false }, { trusted: true }, "disabled"],
		["offline", declaration, { trusted: true, offline: true }, "offline"],
		["untrusted", declaration, {}, "not trusted"],
	] as const)("blocks %s before opening a transport", async (_name, input, options, message) => {
		const calls: string[] = [];
		await expect(runMcpDeclarationProbe(input, fakeTransport(calls), options)).rejects.toThrow(message);
		expect(calls).toEqual([]);
	});

	it("redacts injected transport failures and closes the session", async () => {
		const calls: string[] = [];
		const transport = fakeTransport(calls, {
			async request(request) {
				calls.push(request.method);
				throw new Error("https://alice:secret@catalog.test/mcp?token=secret");
			},
		});
		await expect(runMcpDeclarationProbe(declaration, transport, { trusted: true })).rejects.toThrow(
			"MCP probe failed.",
		);
		expect(calls).toEqual(["open:https://catalog.test/mcp", "initialize", "close"]);
	});

	it("preserves a redacted primary operation failure when close also fails", async () => {
		const transport = fakeTransport([], {
			async request() {
				throw new Error("operation-secret");
			},
			async close() {
				throw new Error("close-secret");
			},
		});
		await expect(runMcpDeclarationProbe(declaration, transport, { trusted: true })).rejects.toThrow(
			"MCP probe failed.",
		);
	});

	it("uses an independent bounded cleanup controller after the operation aborts", async () => {
		let closeCalled = false;
		const transport: McpProbeTransport = {
			async open() {
				return {
					request: async () => new Promise<never>(() => undefined),
					notification: async () => undefined,
					close: async () => {
						closeCalled = true;
						return new Promise<never>(() => undefined);
					},
				};
			},
		};
		await expect(runMcpDeclarationProbe(declaration, transport, { trusted: true, timeoutMs: 10 })).rejects.toThrow(
			"MCP probe timed out.",
		);
		expect(closeCalled).toBe(true);
	});

	it("aborts a hanging injected transport within its bounded timeout", async () => {
		let aborted = false;
		const transport: McpProbeTransport = {
			open({ signal }) {
				signal.addEventListener("abort", () => {
					aborted = true;
				});
				return new Promise(() => undefined);
			},
		};
		await expect(runMcpDeclarationProbe(declaration, transport, { trusted: true, timeoutMs: 10 })).rejects.toThrow(
			"timed out",
		);
		expect(aborted).toBe(true);
	});
});
