import {
	createHostRequestHandler,
	type HostRequestContext,
	type HostRequestHandler,
} from "../src/core/kernel/index.js";

let nextSyntheticHostRequestId = 0;

/** Create a distinct, current dispatcher context for direct host-handler tests. */
export function createSyntheticHostRequestContext(): HostRequestContext {
	const requestNumber = ++nextSyntheticHostRequestId;
	const controller = new AbortController();
	return {
		requestId: `test-host-request-${requestNumber}`,
		generation: requestNumber,
		signal: controller.signal,
		isCurrent: () => !controller.signal.aborted,
	};
}

/** Invoke a production-shaped handler with a synthetic dispatcher context. */
export function invokeHostRequest(
	handler: HostRequestHandler,
	payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	return handler(payload, createSyntheticHostRequestContext());
}

/** Build branded test fixture handlers through the production capability factory. */
export function createTestHostHandlers<T extends Record<string, (...args: any[]) => Promise<Record<string, unknown>>>>(
	handlers: {
		[K in keyof T]: T[K] extends (
			payload: infer P,
			context: infer C,
			...rest: any[]
		) => Promise<Record<string, unknown>>
			? Record<string, unknown> extends P
				? HostRequestContext extends C
					? T[K]
					: never
				: never
			: never;
	},
): Record<keyof T, HostRequestHandler> {
	return Object.fromEntries(
		Object.entries(handlers).map(([type, handler]) => [
			type,
			createHostRequestHandler(
				handler as (
					payload: Record<string, unknown>,
					context: HostRequestContext,
				) => Promise<Record<string, unknown>>,
			),
		]),
	) as Record<keyof T, HostRequestHandler>;
}
