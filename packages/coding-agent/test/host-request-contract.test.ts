import { describe, expect, it } from "vitest";
import {
	assertHostRequestHandler,
	contextAwareHostRequestHandler,
	createHostRequestHandler,
	type HostRequestContext,
} from "../src/core/kernel/index.js";
import { invokeHostRequestThroughKernelForTest as invokeHostRequestHandlerForTest } from "./host-request-context.js";

describe("staged host-request handler authority", () => {
	it("rejects unary factory inputs before they run", () => {
		let calls = 0;
		const unary = async (_payload: Record<string, unknown>): Promise<Record<string, unknown>> => {
			calls += 1;
			return {};
		};

		expect(() => {
			// @ts-expect-error Context-aware registration needs an explicit marker.
			createHostRequestHandler(unary);
		}).toThrow("host request handlers require the context-aware marker");
		expect(calls).toBe(0);
	});

	it("rejects missing or invalid context before a genuine handler runs", async () => {
		let calls = 0;
		const handler = createHostRequestHandler(async (_payload, _context) => {
			calls += 1;
			return {};
		}, contextAwareHostRequestHandler);

		assertHostRequestHandler(handler);
		await expect(handler({}, undefined as unknown as HostRequestContext)).rejects.toThrow(
			"host request context is invalid",
		);
		await expect(handler({}, {} as HostRequestContext)).rejects.toThrow("host request context is invalid");
		await expect(invokeHostRequestHandlerForTest(handler, {})).resolves.toEqual({});
		expect(calls).toBe(1);
	});

	it("rejects copied-symbol forgeries through WeakSet provenance before they run", () => {
		const genuine = createHostRequestHandler(async (_payload, _context) => ({}), contextAwareHostRequestHandler);
		let calls = 0;
		const forged = async (): Promise<Record<string, unknown>> => {
			calls += 1;
			return {};
		};
		const brand = Object.getOwnPropertySymbols(genuine)[0];
		Object.defineProperty(forged, brand, Object.getOwnPropertyDescriptor(genuine, brand)!);

		expect(() => assertHostRequestHandler(forged)).toThrow(
			"host request handler is not a dispatcher-created capability",
		);
		expect(calls).toBe(0);
	});

	it("uses explicit marker rather than implementation length for rest and default handlers", async () => {
		const rest = createHostRequestHandler(
			async (...args: [Record<string, unknown>, HostRequestContext]) => ({
				requestId: args[1].requestId,
			}),
			contextAwareHostRequestHandler,
		);
		const defaulted = createHostRequestHandler(
			async (_payload, context = undefined as unknown as HostRequestContext) => ({
				generation: context.generation,
			}),
			contextAwareHostRequestHandler,
		);
		expect((await invokeHostRequestHandlerForTest(rest, {})).requestId).toEqual(expect.any(String));
		expect((await invokeHostRequestHandlerForTest(defaulted, {})).generation).toBe(1);
	});

	it("does not accept a structural or payload-supplied context", async () => {
		let calls = 0;
		const handler = createHostRequestHandler(async (_payload, _context) => {
			calls += 1;
			return {};
		}, contextAwareHostRequestHandler);
		const fabricated = {
			requestId: "python",
			generation: 1,
			signal: new AbortController().signal,
			isCurrent: () => true,
		};
		await expect(handler({ context: fabricated }, fabricated)).rejects.toThrow("host request context is invalid");
		expect(calls).toBe(0);
	});
});
