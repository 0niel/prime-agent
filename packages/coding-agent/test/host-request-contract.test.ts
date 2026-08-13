import { describe, expect, it } from "vitest";
import {
	assertHostRequestHandler,
	createHostRequestHandler,
	type HostRequestContext,
} from "../src/core/kernel/index.js";
import { invokeHostRequestThroughKernelForTest as invokeHostRequestHandlerForTest } from "./host-request-context.js";

describe("staged host-request handler authority", () => {
	it("rejects missing or invalid context before a genuine handler runs", async () => {
		let calls = 0;
		const handler = createHostRequestHandler(async (_payload, _context) => {
			calls += 1;
			return {};
		});

		assertHostRequestHandler(handler);
		await expect(handler({}, undefined as unknown as HostRequestContext)).rejects.toThrow(
			"host request context is invalid",
		);
		await expect(handler({}, {} as HostRequestContext)).rejects.toThrow("host request context is invalid");
		await expect(invokeHostRequestHandlerForTest(handler, {})).resolves.toEqual({});
		expect(calls).toBe(1);
	});

	it("rejects handlers that were not minted by the factory", () => {
		let calls = 0;
		const forged = async (): Promise<Record<string, unknown>> => {
			calls += 1;
			return {};
		};

		expect(() => assertHostRequestHandler(forged)).toThrow(
			"host request handler is not a dispatcher-created capability",
		);
		expect(calls).toBe(0);
	});

	it("passes dispatcher context to rest and default-parameter handlers", async () => {
		const rest = createHostRequestHandler(async (...args: [Record<string, unknown>, HostRequestContext]) => ({
			aborted: args[1].signal.aborted,
		}));
		const defaulted = createHostRequestHandler(
			async (_payload, context = undefined as unknown as HostRequestContext) => ({
				aborted: context.signal.aborted,
			}),
		);
		expect((await invokeHostRequestHandlerForTest(rest, {})).aborted).toBe(false);
		expect((await invokeHostRequestHandlerForTest(defaulted, {})).aborted).toBe(false);
	});

	it("does not accept a structural or payload-supplied context", async () => {
		let calls = 0;
		const handler = createHostRequestHandler(async (_payload, _context) => {
			calls += 1;
			return {};
		});
		const fabricated = {
			signal: new AbortController().signal,
			isCurrent: () => true,
		};
		await expect(handler({ context: fabricated }, fabricated)).rejects.toThrow("host request context is invalid");
		expect(calls).toBe(0);
	});
});
