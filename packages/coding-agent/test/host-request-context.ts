import {
	contextAwareHostRequestHandler,
	createHostRequestHandler,
	type HostRequestContext,
	type HostRequestHandlerImplementation,
	invokeHostRequestHandlerForTest,
} from "../src/core/kernel/index.js";

/** Invoke only through a dispatcher-minted context; fixtures cannot fabricate one. */
export function invokeHostRequest(
	handler: HostRequestHandlerImplementation,
	payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	return invokeHostRequestHandlerForTest(handler, payload);
}

/** Build factory-minted handlers for integration tests. Context identity is host-private. */
export function createTestHostHandlers<
	T extends Record<
		string,
		(payload: Record<string, unknown>, context: HostRequestContext) => Promise<Record<string, unknown>>
	>,
>(handlers: T): Record<keyof T, HostRequestHandlerImplementation> {
	return Object.fromEntries(
		Object.entries(handlers).map(([type, handler]) => [
			type,
			createHostRequestHandler(handler, contextAwareHostRequestHandler),
		]),
	) as unknown as Record<keyof T, HostRequestHandlerImplementation>;
}
