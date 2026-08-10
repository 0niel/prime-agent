import { describe, expect, it } from "vitest";
import {
	createStreamingJsonParseState,
	getStreamingJsonStrictValidationCountForTesting,
	parseStreamingJson,
} from "../src/utils/json-parse.js";

function chunks(input: string, sizes: number[]): string[] {
	const result: string[] = [];
	let offset = 0;
	let step = 0;
	while (offset < input.length) {
		const size = sizes[step++ % sizes.length];
		result.push(input.slice(offset, offset + size));
		offset += size;
	}
	return result;
}

describe("incremental streaming JSON parse state", () => {
	it("matches legacy previews and strictly validates exactly once", () => {
		const document = JSON.stringify({ empty: {}, array: [true, null, { nested: [1, 2, "ok"] }], number: -12.5e2 });
		const state = createStreamingJsonParseState<Record<string, unknown>>();
		let prefix = "";
		for (const chunk of chunks(document, [1, 7, 31])) {
			prefix += chunk;
			expect(state.append(chunk)).toEqual(parseStreamingJson(prefix));
			expect(state.preview()).toEqual(parseStreamingJson(prefix));
		}
		expect(state.finalize()).toEqual(JSON.parse(document));
		expect(getStreamingJsonStrictValidationCountForTesting(state)).toBe(1);
		expect(() => state.finalize()).toThrow();
		expect(() => state.append(" ")).toThrow();
	});

	it("preserves literal unicode, surrogate, and escape chunk boundaries", () => {
		const document = '{"literal":"é😀\\u2028\\u2029","decomposed":"é","escaped":"\\uD83D\\uDE00"}';
		const split = document.indexOf("😀") + 1;
		const pieces = [
			document.slice(0, split),
			document.slice(split, split + 1),
			...chunks(document.slice(split + 1), [1, 2, 7]),
		];
		const state = createStreamingJsonParseState<Record<string, unknown>>();
		let prefix = "";
		for (const chunk of pieces) {
			prefix += chunk;
			expect(state.append(chunk)).toEqual(parseStreamingJson(prefix));
		}
		expect(state.finalize()).toEqual(JSON.parse(document));
	});

	it("keeps malformed, nesting, and truncation input non-authoritative", () => {
		for (const document of ['{"a":"\\u12', '{"a":[1,2}', '{"a":1} junk', '{"a":"raw\ncontrol"}', '{"a":1e}']) {
			const state = createStreamingJsonParseState<Record<string, unknown>>();
			let prefix = "";
			for (const chunk of chunks(document, [1, 7])) {
				prefix += chunk;
				expect(state.append(chunk)).toEqual(parseStreamingJson(prefix));
			}
			expect(() => state.finalize()).toThrow();
			expect(getStreamingJsonStrictValidationCountForTesting(state)).toBe(1);
		}
	});

	it("handles depth 64 incrementally", () => {
		let value: unknown = { leaf: "value" };
		for (let index = 0; index < 64; index++) value = { index, value };
		const document = JSON.stringify(value);
		const state = createStreamingJsonParseState();
		for (const chunk of chunks(document, [257])) state.append(chunk);
		expect(state.finalize()).toEqual(JSON.parse(document));
	});
});
