import { parse as partialParse } from "partial-json";

const VALID_JSON_ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t", "u"]);

function isControlCharacter(char: string): boolean {
	const codePoint = char.codePointAt(0);
	return codePoint !== undefined && codePoint >= 0x00 && codePoint <= 0x1f;
}

function escapeControlCharacter(char: string): string {
	switch (char) {
		case "\b":
			return "\\b";
		case "\f":
			return "\\f";
		case "\n":
			return "\\n";
		case "\r":
			return "\\r";
		case "\t":
			return "\\t";
		default:
			return `\\u${char.codePointAt(0)?.toString(16).padStart(4, "0") ?? "0000"}`;
	}
}

/**
 * Repairs malformed JSON string literals by:
 * - escaping raw control characters inside strings
 * - doubling backslashes before invalid escape characters
 */
export function repairJson(json: string): string {
	let repaired = "";
	let inString = false;

	for (let index = 0; index < json.length; index++) {
		const char = json[index];

		if (!inString) {
			repaired += char;
			if (char === '"') {
				inString = true;
			}
			continue;
		}

		if (char === '"') {
			repaired += char;
			inString = false;
			continue;
		}

		if (char === "\\") {
			const nextChar = json[index + 1];
			if (nextChar === undefined) {
				repaired += "\\\\";
				continue;
			}

			if (nextChar === "u") {
				const unicodeDigits = json.slice(index + 2, index + 6);
				if (/^[0-9a-fA-F]{4}$/.test(unicodeDigits)) {
					repaired += `\\u${unicodeDigits}`;
					index += 5;
					continue;
				}
			}

			if (VALID_JSON_ESCAPES.has(nextChar)) {
				repaired += `\\${nextChar}`;
				index += 1;
				continue;
			}

			repaired += "\\\\";
			continue;
		}

		repaired += isControlCharacter(char) ? escapeControlCharacter(char) : char;
	}

	return repaired;
}

export function parseJsonWithRepair<T>(json: string): T {
	try {
		return JSON.parse(json) as T;
	} catch (error) {
		const repairedJson = repairJson(json);
		if (repairedJson !== json) {
			return JSON.parse(repairedJson) as T;
		}
		throw error;
	}
}

/**
 * Attempts to parse potentially incomplete JSON during streaming.
 * Always returns a valid object, even if the JSON is incomplete.
 *
 * @param partialJson The partial JSON string from streaming
 * @returns Parsed object or empty object if parsing fails
 */
export function parseStreamingJson<T = Record<string, unknown>>(partialJson: string | undefined): T {
	if (!partialJson || partialJson.trim() === "") {
		return {} as T;
	}

	try {
		return parseJsonWithRepair<T>(partialJson);
	} catch {
		try {
			const result = partialParse(partialJson);
			return (result ?? {}) as T;
		} catch {
			try {
				const result = partialParse(repairJson(partialJson));
				return (result ?? {}) as T;
			} catch {
				return {} as T;
			}
		}
	}
}

/**
 * Incremental, display-only JSON parser for streamed tool arguments. Unlike
 * `parseStreamingJson`, this never reparses the accumulated prefix. The raw
 * document is retained solely for the one strict terminal validation.
 */
export interface StreamingJsonParseState<T = Record<string, unknown>> {
	append(delta: string): T;
	preview(): T;
	finalize(): T;
}

type Container = Record<string, unknown> | unknown[];
type Frame = {
	value: Container;
	kind: "object" | "array";
	key?: string;
	expecting: "key" | "colon" | "value" | "comma";
};
type StringToken = { target: "key" | "value"; value: string; escape: boolean; unicode: string | undefined };
type ScalarToken = { value: string; target: "value" };

/**
 * The lexer deliberately advances UTF-16 code units: a surrogate pair split
 * between stream chunks is therefore indistinguishable from the same input in
 * one chunk. Preview is best effort; only finalize is authoritative.
 */
class IncrementalStreamingJsonParseState<T> implements StreamingJsonParseState<T> {
	private readonly rawChunks: string[] = [];
	private terminal = false;
	private root: unknown = {};
	private hasRoot = false;
	private rootComplete = false;
	private previewInvalid = false;
	private readonly frames: Frame[] = [];
	private stringToken: StringToken | undefined;
	private scalarToken: ScalarToken | undefined;
	private strictValidationCount = 0;

	append(delta: string): T {
		if (this.terminal) throw new Error("Cannot append after streaming JSON finalization");
		if (typeof delta !== "string") throw new TypeError("Streaming JSON delta must be a string");
		this.rawChunks.push(delta);
		for (let index = 0; index < delta.length; index++) this.consume(delta[index]);
		return this.preview();
	}

	preview(): T {
		if (this.terminal) throw new Error("Cannot preview after streaming JSON finalization");
		return (this.previewInvalid ? {} : this.hasRoot ? this.root : {}) as T;
	}

	finalize(): T {
		if (this.terminal) throw new Error("Streaming JSON has already been finalized");
		this.terminal = true;
		const raw = this.rawChunks.join("");
		this.rawChunks.length = 0;
		this.strictValidationCount++;
		return JSON.parse(raw) as T;
	}

	/** Test-only inspection; intentionally not part of the exported interface. */
	getStrictValidationCountForTesting(): number {
		return this.strictValidationCount;
	}

	getRawForProviderCheck(): string {
		return this.rawChunks.join("");
	}

	private consume(char: string): void {
		if (this.stringToken) {
			this.consumeString(char);
			return;
		}
		if (this.scalarToken) {
			if (char === "," || char === "]" || char === "}" || isWhitespace(char)) {
				this.finishScalar();
				this.consume(char);
			} else {
				this.scalarToken.value += char;
				this.updateScalarPreview();
			}
			return;
		}
		if (isWhitespace(char) || this.rootComplete) return;
		const frame = this.frames.at(-1);
		if (char === "{") {
			this.beginValue({});
			this.frames.push({ value: this.rootOrCurrentValue(), kind: "object", expecting: "key" });
			return;
		}
		if (char === "[") {
			this.beginValue([]);
			this.frames.push({ value: this.rootOrCurrentValue(), kind: "array", expecting: "value" });
			return;
		}
		if (char === '"') {
			if (frame?.kind === "object" && frame.expecting === "key") {
				this.stringToken = { target: "key", value: "", escape: false, unicode: undefined };
			} else {
				this.beginValue("");
				this.stringToken = { target: "value", value: "", escape: false, unicode: undefined };
			}
			return;
		}
		if (char === ":") {
			if (frame?.kind === "object") frame.expecting = "value";
			return;
		}
		if (char === ",") {
			if (frame) frame.expecting = frame.kind === "object" ? "key" : "value";
			return;
		}
		if (char === "}" || char === "]") {
			if (frame && ((char === "}" && frame.kind === "object") || (char === "]" && frame.kind === "array"))) {
				this.frames.pop();
				this.valueComplete();
				if (this.frames.length === 0) this.rootComplete = true;
			}
			return;
		}
		this.scalarToken = { target: "value", value: char };
		this.beginValue(this.previewScalar(char));
	}

	private consumeString(char: string): void {
		const token = this.stringToken!;
		if (token.unicode !== undefined) {
			token.unicode += char;
			if (token.unicode.length === 4) {
				if (/^[0-9a-fA-F]{4}$/.test(token.unicode))
					token.value += String.fromCharCode(Number.parseInt(token.unicode, 16));
				token.unicode = undefined;
				this.updateStringPreview(token);
			}
			return;
		}
		if (token.escape) {
			token.escape = false;
			if (char === "u") token.unicode = "";
			else {
				const escaped: Record<string, string> = {
					'"': '"',
					"\\": "\\",
					"/": "/",
					b: "\b",
					f: "\f",
					n: "\n",
					r: "\r",
					t: "\t",
				};
				if (char in escaped) token.value += escaped[char];
				this.updateStringPreview(token);
			}
			return;
		}
		if (char === "\\") {
			token.escape = true;
			return;
		}
		if (char === '"') {
			this.previewInvalid = false;
			this.stringToken = undefined;
			if (token.target === "key") {
				const frame = this.frames.at(-1);
				if (frame?.kind === "object") {
					frame.key = token.value;
					frame.expecting = "colon";
				}
			} else this.valueComplete();
			return;
		}
		if (char.charCodeAt(0) < 0x20) this.previewInvalid = true;
		token.value += char;
		this.updateStringPreview(token);
	}

	private beginValue(value: unknown): void {
		const frame = this.frames.at(-1);
		if (!frame) {
			this.root = value;
			this.hasRoot = true;
			return;
		}
		if (frame.kind === "array") (frame.value as unknown[]).push(value);
		else if (frame.key !== undefined) (frame.value as Record<string, unknown>)[frame.key] = value;
		frame.expecting = "comma";
	}

	private rootOrCurrentValue(): Container {
		const parent = this.frames.at(-1);
		if (!parent) return this.root as Container;
		if (parent.kind === "array") {
			const values = parent.value as unknown[];
			return values[values.length - 1] as Container;
		}
		return (parent.value as Record<string, unknown>)[parent.key!] as Container;
	}

	private valueComplete(): void {
		const frame = this.frames.at(-1);
		if (frame) frame.expecting = "comma";
	}

	private updateStringPreview(token: StringToken): void {
		if (token.target === "value") this.replaceCurrentValue(token.value);
	}

	private updateScalarPreview(): void {
		this.replaceCurrentValue(this.previewScalar(this.scalarToken!.value));
	}

	private replaceCurrentValue(value: unknown): void {
		const frame = this.frames.at(-1);
		if (!frame) this.root = value;
		else if (frame.kind === "array") {
			const values = frame.value as unknown[];
			values[values.length - 1] = value;
		} else if (frame.key !== undefined) {
			(frame.value as Record<string, unknown>)[frame.key] = value;
		}
	}

	private finishScalar(): void {
		if (!this.scalarToken) return;
		this.updateScalarPreview();
		this.scalarToken = undefined;
		this.valueComplete();
		if (this.frames.length === 0) this.rootComplete = true;
	}

	private previewScalar(value: string): unknown {
		if (value === "true" || value === "t" || value === "tr" || value === "tru") return true;
		if (value === "false" || value === "f" || value === "fa" || value === "fal" || value === "fals") return false;
		if (value === "null" || value === "n" || value === "nu" || value === "nul") return null;
		// This accepts only the JSON number grammar. An unfinished exponent is
		// represented by its completed mantissa, matching the legacy preview.
		if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)) return Number(value);
		const exponent = value.search(/[eE]/);
		if (exponent > 0 && /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value.slice(0, exponent))) {
			return Number(value.slice(0, exponent));
		}
		return {};
	}
}

function isWhitespace(char: string): boolean {
	return char === " " || char === "\n" || char === "\r" || char === "\t";
}

export function createStreamingJsonParseState<T = Record<string, unknown>>(): StreamingJsonParseState<T> {
	return new IncrementalStreamingJsonParseState<T>();
}

/** Internal test seam; production callers should use the public interface. */
export function getStreamingJsonStrictValidationCountForTesting(state: StreamingJsonParseState<unknown>): number {
	return (state as IncrementalStreamingJsonParseState<unknown>).getStrictValidationCountForTesting();
}

/** Internal provider seam; never serialize this raw value. */
export function getStreamingJsonRawForProviderCheck(state: StreamingJsonParseState<unknown>): string {
	return (state as IncrementalStreamingJsonParseState<unknown>).getRawForProviderCheck();
}
