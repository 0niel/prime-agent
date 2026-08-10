import { describe, expect, it } from "vitest";
import { retryUnavailableSnapshot } from "./rss-snapshot-retry.js";

interface FakeClock {
	time: number;
	pauses: number[];
	now(): number;
	pause(milliseconds: number): Promise<void>;
}

function clock(): FakeClock {
	return {
		time: 0,
		pauses: [],
		now() {
			return this.time;
		},
		async pause(milliseconds) {
			this.pauses.push(milliseconds);
			this.time += milliseconds;
		},
	};
}

describe("RSS proc snapshot retry window", () => {
	it("accepts a coherent snapshot after a deterministic transient sequence beyond three attempts", async () => {
		const fake = clock();
		let attempts = 0;
		const result = await retryUnavailableSnapshot(
			async () => (attempts++ < 8 ? "unavailable" : "coherent"),
			(snapshot) => snapshot === "unavailable",
			fake,
			20,
			2,
		);
		expect(result).toBe("coherent");
		expect(attempts).toBe(9);
		expect(fake.pauses).toEqual([2, 2, 2, 2, 2, 2, 2, 2]);
		expect(fake.time).toBe(16);
	});

	it("returns persistent unavailability at the monotonic deadline without inventing an empty snapshot", async () => {
		const fake = clock();
		let attempts = 0;
		const result = await retryUnavailableSnapshot(
			async () => {
				attempts += 1;
				return "unavailable";
			},
			(snapshot) => snapshot === "unavailable",
			fake,
			20,
			2,
		);
		expect(result).toBe("unavailable");
		expect(attempts).toBe(10);
		expect(fake.pauses).toHaveLength(10);
		expect(fake.time).toBe(20);
	});
});
