import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	parseSwarmRolePolicy,
	projectSwarmRoleMetadata,
	resolveSwarmRoleAssignment,
	validateSwarmSharedContext,
} from "../src/core/swarm-role-policy.js";

const policy = {
	version: 1,
	modelProfiles: { neutral_profile: { model: "neutral/provider-model", thinkingLevel: "high" } },
	roles: {
		reviewer_1: {
			modelProfile: "neutral_profile",
			decisionScopes: ["review"],
			implementationScopes: ["patch"],
			allowedToolNames: ["read"],
			delegableRoleIds: [],
			instructions: "Review only.",
			sharedContext: { maxItems: 2, maxBytes: 200, allowedKinds: ["note"] },
		},
	},
};
const model = { provider: "neutral", id: "provider-model" } as Model<Api>;

describe("swarm role policy", () => {
	it("canonicalizes authority independent of object key order", () => {
		const first = parseSwarmRolePolicy(policy);
		const second = parseSwarmRolePolicy({ roles: policy.roles, modelProfiles: policy.modelProfiles, version: 1 });
		expect(first.digest).toBe(second.digest);
		expect(
			parseSwarmRolePolicy({
				...policy,
				roles: { ...policy.roles, reviewer_1: { ...policy.roles.reviewer_1, decisionScopes: [] } },
			}).digest,
		).not.toBe(first.digest);
	});

	it("resolves only an exact authenticated selector and parent tool intersection", () => {
		const snapshot = parseSwarmRolePolicy(policy);
		const assignment = resolveSwarmRoleAssignment({
			snapshot,
			assignmentId: "assignment-1",
			role: "reviewer_1",
			decisionScopes: ["review"],
			implementationScopes: ["patch"],
			sharedContext: [{ kind: "note", text: "untrusted" }],
			models: [model],
			parentToolNames: ["read", "write"],
		});
		expect(assignment.model).toBe("neutral/provider-model");
		expect(assignment.allowedToolNames).toEqual(["read"]);
		expect(() =>
			resolveSwarmRoleAssignment({
				...{ snapshot, assignmentId: "a", role: "reviewer_1", models: [model], parentToolNames: [] },
				decisionScopes: [],
			}),
		).toThrow("unavailable to parent");
		expect(() =>
			resolveSwarmRoleAssignment({
				snapshot,
				assignmentId: "a",
				role: "reviewer_1",
				models: [{ ...model, id: "provider-model-v2" }],
				parentToolNames: ["read"],
			}),
		).toThrow("exactly available");
	});

	it("fails closed for duplicate grants, malformed values, nested escalation, and oversized context", () => {
		expect(() =>
			parseSwarmRolePolicy({ ...policy, roles: { ...policy.roles, default: policy.roles.reviewer_1 } }),
		).toThrow("reserved");
		expect(() =>
			parseSwarmRolePolicy({
				...policy,
				roles: {
					...policy.roles,
					reviewer_1: { ...policy.roles.reviewer_1, decisionScopes: ["review", "review"] },
				},
			}),
		).toThrow("duplicate");
		const snapshot = parseSwarmRolePolicy(policy);
		expect(() =>
			validateSwarmSharedContext(
				[{ kind: "note", text: "x".repeat(201) }],
				snapshot.policy.roles.reviewer_1.sharedContext,
			),
		).toThrow("byte limit");
		expect(() =>
			resolveSwarmRoleAssignment({
				snapshot,
				assignmentId: "a",
				role: "reviewer_1",
				decisionScopes: ["review"],
				models: [model],
				parentToolNames: ["read"],
				parentAssignment: { delegableRoleIds: [], decisionScopes: ["review"], implementationScopes: [] },
			}),
		).toThrow("not delegable");
	});

	it("projects a bounded sorted minimal role catalog", () => {
		const snapshot = parseSwarmRolePolicy(policy);
		expect(projectSwarmRoleMetadata(snapshot)).toEqual([
			{
				id: "reviewer_1",
				modelProfile: "neutral_profile",
				decisionScopes: ["review"],
				implementationScopes: ["patch"],
			},
		]);
	});
});
