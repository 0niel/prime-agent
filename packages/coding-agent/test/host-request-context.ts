import { randomUUID } from "node:crypto";
import {
	contextAwareHostRequestHandler,
	createHostRequestHandler,
	type HostRequestContext,
	type HostRequestHandlerImplementation,
	KernelManager,
} from "../src/core/kernel/index.js";

/** Raw implementations are retained only for test-created business-unit fixtures. */
const testHostHandlerImplementations = new WeakMap<
	HostRequestHandlerImplementation,
	HostRequestHandlerImplementation
>();

/**
 * Calls a raw test fixture with synthetic context. This deliberately bypasses the
 * production wrapper and never registers context identity with production authority.
 */
export async function invokeHostRequestHandlerForTest(
	handler: HostRequestHandlerImplementation,
	payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const implementation = testHostHandlerImplementations.get(handler);
	if (!implementation) {
		throw new Error("host request handler has no test-local raw implementation");
	}
	const controller = new AbortController();
	const context: HostRequestContext = {
		requestId: randomUUID(),
		generation: 0,
		signal: controller.signal,
		isCurrent: () => !controller.signal.aborted,
	};
	try {
		return await implementation(payload, context);
	} finally {
		controller.abort();
	}
}

/**
 * Exercises a production capability only through the KernelManager's private
 * dispatcher, preserving its authority and revocation boundary in integration tests.
 */
export async function invokeHostRequestThroughKernelForTest(
	handler: HostRequestHandlerImplementation,
	payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const manager = new KernelManager({ cwd: process.cwd(), hostHandlers: { test: handler } });
	const replies: Record<string, unknown>[] = [];
	const internals = manager as unknown as {
		startHostRequestFromComm: (commId: string, data: unknown) => void;
		sendCommMessage: (commId: string, data: Record<string, unknown>) => Promise<void>;
		inFlightHostRequests: Set<Promise<void>>;
	};
	internals.sendCommMessage = async (_commId, data) => {
		replies.push(data);
	};
	internals.startHostRequestFromComm("test-host-request", { type: "test", ...payload });
	await Promise.allSettled([...internals.inFlightHostRequests]);
	const reply = replies[0];
	if (!reply) throw new Error("test host request did not produce a reply");
	if (reply.status === "error") throw new Error(String(reply.error));
	const { status: _status, ...result } = reply;
	return result;
}

/** Build factory-minted handlers for test fixtures while retaining raw implementations locally. */
export function createTestHostHandlers<
	T extends Record<
		string,
		(payload: Record<string, unknown>, context: HostRequestContext) => Promise<Record<string, unknown>>
	>,
>(handlers: T): Record<keyof T, HostRequestHandlerImplementation> {
	return Object.fromEntries(
		Object.entries(handlers).map(([type, implementation]) => {
			const handler = createHostRequestHandler(implementation, contextAwareHostRequestHandler);
			testHostHandlerImplementations.set(handler, implementation);
			return [type, handler];
		}),
	) as unknown as Record<keyof T, HostRequestHandlerImplementation>;
}
