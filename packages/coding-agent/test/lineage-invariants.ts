import type { LineageManifest } from "../src/core/lineage.js";

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

function fail(message: string): never {
	throw new Error(message);
}

function unique<T>(items: T[], key: (item: T) => string, label: string): Map<string, T> {
	const indexed = new Map<string, T>();
	for (const item of items) {
		const id = key(item);
		if (!ID_PATTERN.test(id)) fail(`invalid lineage ${label} id: ${id}`);
		if (indexed.has(id)) fail(`duplicate lineage ${label} id: ${id}`);
		indexed.set(id, item);
	}
	return indexed;
}

function assertAcyclic(records: Map<string, { parent?: string }>, label: string): void {
	for (const start of records.keys()) {
		const seen = new Set<string>();
		let current: string | undefined = start;
		while (current !== undefined) {
			if (seen.has(current)) fail(`lineage ${label} cycle at ${current}`);
			seen.add(current);
			current = records.get(current)?.parent;
		}
	}
}

/**
 * Port of the verifiers lineage-v1 LineageManifest.validate_references rules
 * (verifiers/v1/lineage.py @ 1a95107b), so producer output is checked against
 * the consumer contract without a cross-repo dependency.
 */
export function assertLineageManifestInvariants(manifest: LineageManifest): void {
	const sessions = unique(manifest.sessions, (session) => session.session_id, "session");
	const contexts = unique(manifest.contexts, (context) => context.context_id, "context");
	const compactions = unique(manifest.compactions, (compaction) => compaction.compaction_id, "compaction");
	const requests = unique(manifest.requests, (request) => request.request_id, "request");

	const roots = manifest.sessions.filter((session) => session.parent_session_id === undefined);
	if (roots.length !== 1) fail("ACP lineage must contain exactly one root session");

	for (const session of manifest.sessions) {
		if (session.parent_session_id === undefined) {
			if (session.depth !== 0) fail(`root session ${session.session_id} must have depth 0`);
			if (session.spawned_by_request_id !== undefined) {
				fail(`root session ${session.session_id} cannot have a spawn request`);
			}
		} else {
			const parent = sessions.get(session.parent_session_id);
			if (!parent) fail(`session ${session.session_id} references unknown parent`);
			if (session.depth !== parent.depth + 1) fail(`session ${session.session_id} has inconsistent depth`);
			if (session.spawned_by_request_id === undefined) {
				fail(`session ${session.session_id} requires a spawn request`);
			}
		}
		const initial = contexts.get(session.initial_context_id);
		if (!initial || initial.session_id !== session.session_id || initial.previous_context_id !== undefined) {
			fail(`session ${session.session_id} has an invalid initial context`);
		}
		const initialContexts = manifest.contexts.filter(
			(context) => context.session_id === session.session_id && context.previous_context_id === undefined,
		);
		if (initialContexts.length !== 1 || initialContexts[0]?.context_id !== session.initial_context_id) {
			fail(`session ${session.session_id} must have exactly one initial context`);
		}
	}
	assertAcyclic(
		new Map(manifest.sessions.map((session) => [session.session_id, { parent: session.parent_session_id }])),
		"session",
	);

	for (const context of manifest.contexts) {
		const session = sessions.get(context.session_id);
		if (!session) fail(`context ${context.context_id} references unknown session`);
		if (context.previous_context_id === undefined) {
			const expected = session.parent_session_id === undefined ? "root" : "spawn";
			if (context.transition !== expected) {
				fail(`initial context ${context.context_id} must transition as ${expected}`);
			}
			if (context.compaction_id !== undefined) {
				fail(`initial context ${context.context_id} cannot have a compaction id`);
			}
		} else {
			const prior = contexts.get(context.previous_context_id);
			if (!prior || prior.session_id !== context.session_id) {
				fail(`context ${context.context_id} has an invalid previous context`);
			}
			if (context.transition !== "compact" || context.compaction_id === undefined) {
				fail(`replacement context ${context.context_id} must name its compaction`);
			}
			const compaction = compactions.get(context.compaction_id);
			if (!compaction || compaction.status !== "completed" || compaction.target_context_id !== context.context_id) {
				fail(`replacement context ${context.context_id} has an invalid compaction`);
			}
		}
	}
	assertAcyclic(
		new Map(manifest.contexts.map((context) => [context.context_id, { parent: context.previous_context_id }])),
		"context",
	);

	for (const request of manifest.requests) {
		const context = contexts.get(request.context_id);
		if (!sessions.has(request.session_id) || !context || context.session_id !== request.session_id) {
			fail(`request ${request.request_id} has an invalid session/context`);
		}
		if (request.kind === "compaction" && request.compaction_id === undefined) {
			fail(`compaction request ${request.request_id} requires a compaction id`);
		}
		if (request.compaction_id !== undefined) {
			const compaction = compactions.get(request.compaction_id);
			if (!compaction || compaction.session_id !== request.session_id) {
				fail(`request ${request.request_id} has an invalid compaction`);
			}
			const expectedContext =
				request.kind === "compaction" ? compaction.source_context_id : compaction.target_context_id;
			if (request.context_id !== expectedContext) {
				fail(`request ${request.request_id} is on the wrong compaction context`);
			}
		} else if (request.kind === "turn" && context.compaction_id !== undefined) {
			fail(`request ${request.request_id} is missing its context compaction`);
		}
	}

	for (const session of manifest.sessions) {
		if (session.spawned_by_request_id === undefined) continue;
		const spawn = requests.get(session.spawned_by_request_id);
		if (!spawn || spawn.kind !== "turn" || spawn.session_id !== session.parent_session_id) {
			fail(`session ${session.session_id} has an invalid spawn request`);
		}
	}

	for (const compaction of manifest.compactions) {
		const source = contexts.get(compaction.source_context_id);
		if (!sessions.has(compaction.session_id) || !source || source.session_id !== compaction.session_id) {
			fail(`compaction ${compaction.compaction_id} has an invalid source context`);
		}
		const target = compaction.target_context_id ? contexts.get(compaction.target_context_id) : undefined;
		if (compaction.status === "completed") {
			if (
				!target ||
				target.session_id !== compaction.session_id ||
				target.previous_context_id !== compaction.source_context_id ||
				target.transition !== "compact" ||
				target.compaction_id !== compaction.compaction_id
			) {
				fail(`compaction ${compaction.compaction_id} does not describe its target context`);
			}
		} else if (compaction.target_context_id !== undefined) {
			fail(`non-completed compaction ${compaction.compaction_id} cannot have a target context`);
		}
		const request = requests.get(compaction.summary_request_id);
		if (
			!request ||
			request.kind !== "compaction" ||
			request.session_id !== compaction.session_id ||
			request.context_id !== compaction.source_context_id ||
			request.compaction_id !== compaction.compaction_id
		) {
			fail(`compaction ${compaction.compaction_id} has an invalid request`);
		}
	}
}
