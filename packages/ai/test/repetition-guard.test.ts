import { describe, expect, it } from "vitest";
import { RepetitionGuard } from "../src/utils/repetition-guard.js";

function feed(text: string, chunkSize = 37) {
	const guard = new RepetitionGuard();
	for (let offset = 0; offset < text.length; offset += chunkSize) {
		const match = guard.push(text.slice(offset, offset + chunkSize));
		if (match) return match;
	}
	return undefined;
}

describe("RepetitionGuard", () => {
	it("detects a periodic tail independently of chunk boundaries", () => {
		const match = feed("The the the the the the the ".repeat(2_366));
		expect(match).toMatchObject({ reason: "periodic_tail" });
		expect(match?.inspectedCharacters).toBeLessThan(20_000);
	});

	it("detects a low-novelty drifting loop", () => {
		const drifting = Array.from(
			{ length: 1_000 },
			(_, index) => `Still waiting for external approval in phase ${index % 8}; no action is available. `,
		).join("");
		expect(feed(drifting)).toMatchObject({ reason: "novelty_stall" });
	});

	it("does not inspect short stutters or formatting-only padding", () => {
		expect(feed("repeat ".repeat(200))).toBeUndefined();
		expect(feed(" \n\t".repeat(5_000))).toBeUndefined();
	});

	it.each([
		[
			"prose reasoning",
			Array.from(
				{ length: 1_200 },
				(_, index) => `Step ${index} compares evidence item ${index * 7} with hypothesis ${index * 13}. `,
			).join(""),
		],
		[
			"source code",
			Array.from(
				{ length: 800 },
				(_, index) => `const value${index} = input${index} + ${index}; // independently derived ${index * 17}\n`,
			).join(""),
		],
		[
			"markdown table",
			Array.from({ length: 800 }, (_, index) => `| row-${index} | metric-${index * 3} | ${index * 11} |\n`).join(""),
		],
		[
			"JSON",
			JSON.stringify(
				Array.from({ length: 800 }, (_, index) => ({ id: index, value: index * 19, key: `item-${index}` })),
			),
		],
	])("does not flag legitimate long %s", (_name, text) => {
		expect(feed(text)).toBeUndefined();
	});
});
