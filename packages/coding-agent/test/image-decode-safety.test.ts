import { describe, expect, it } from "vitest";
import {
	assertImageEncodedSize,
	MAX_IMAGE_DIMENSION,
	MAX_IMAGE_ENCODED_BYTES,
	MAX_IMAGE_PIXELS,
	parseImageDimensions,
	validateImageForDecode,
} from "../src/utils/image-decode-safety.js";

function png(width: number, height: number): Uint8Array {
	const bytes = Buffer.alloc(24);
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
	bytes.writeUInt32BE(13, 8);
	bytes.write("IHDR", 12, "ascii");
	bytes.writeUInt32BE(width, 16);
	bytes.writeUInt32BE(height, 20);
	return bytes;
}

function jpeg(width: number, height: number): Uint8Array {
	return Uint8Array.from([
		0xff,
		0xd8,
		0xff,
		0xe0,
		0x00,
		0x04,
		0x00,
		0x00,
		0xff,
		0xc2,
		0x00,
		0x08,
		0x08,
		height >> 8,
		height & 0xff,
		width >> 8,
		width & 0xff,
		0x01,
		0xff,
		0xd9,
	]);
}

function gif(width: number, height: number, frameWidth: number, frameHeight: number): Uint8Array {
	const bytes = Buffer.alloc(26);
	bytes.write("GIF89a", 0, "ascii");
	bytes.writeUInt16LE(width, 6);
	bytes.writeUInt16LE(height, 8);
	bytes[12] = 0;
	bytes[13] = 0x2c;
	bytes.writeUInt16LE(frameWidth, 18);
	bytes.writeUInt16LE(frameHeight, 20);
	bytes[22] = 0;
	bytes[23] = 2;
	bytes[24] = 0;
	bytes[25] = 0x3b;
	return bytes;
}

function webpChunk(kind: "VP8 " | "VP8L" | "VP8X", payload: Uint8Array): Uint8Array {
	const bytes = Buffer.alloc(20 + payload.length);
	bytes.write("RIFF", 0, "ascii");
	bytes.writeUInt32LE(bytes.length - 8, 4);
	bytes.write("WEBP", 8, "ascii");
	bytes.write(kind, 12, "ascii");
	bytes.writeUInt32LE(payload.length, 16);
	Buffer.from(payload).copy(bytes, 20);
	return bytes;
}

function bmp(width: number, height: number): Uint8Array {
	const bytes = Buffer.alloc(54);
	bytes.write("BM", 0, "ascii");
	bytes.writeUInt32LE(40, 14);
	bytes.writeInt32LE(width, 18);
	bytes.writeInt32LE(height, 22);
	return bytes;
}

describe("parseImageDimensions", () => {
	it.each([
		["PNG", png(321, 123), { width: 321, height: 123, format: "png" }],
		["progressive JPEG", jpeg(321, 123), { width: 321, height: 123, format: "jpeg" }],
		["GIF", gif(321, 123, 400, 200), { width: 321, height: 123, format: "gif" }],
		["BMP", bmp(321, -123), { width: 321, height: 123, format: "bmp" }],
	])("parses %s dimensions", (_name, bytes, expected) => {
		expect(parseImageDimensions(bytes as Uint8Array)).toEqual(expected);
	});

	it.each([
		[
			"VP8X",
			webpChunk("VP8X", Uint8Array.from([0, 0, 0, 0, 0x40, 0x01, 0, 0x7a, 0, 0])),
			{ width: 321, height: 123, format: "webp" },
		],
		[
			"VP8L",
			webpChunk("VP8L", Uint8Array.from([0x2f, 0x40, 0x81, 0x1e, 0x00])),
			{ width: 321, height: 123, format: "webp" },
		],
		[
			"VP8",
			webpChunk("VP8 ", Uint8Array.from([0, 0, 0, 0x9d, 0x01, 0x2a, 0x41, 0x01, 0x7b, 0x00])),
			{ width: 321, height: 123, format: "webp" },
		],
	])("parses WebP %s dimensions", (_name, bytes, expected) => {
		expect(parseImageDimensions(bytes as Uint8Array)).toEqual(expected);
	});

	it("returns null for malformed and unknown headers", () => {
		expect(parseImageDimensions(Uint8Array.from([1, 2, 3]))).toBeNull();
		expect(parseImageDimensions(png(0, 0).subarray(0, 15))).toBeNull();
	});
});

describe("validateImageForDecode", () => {
	it("rejects an oversized source before its bytes are loaded", () => {
		expect(() => assertImageEncodedSize(MAX_IMAGE_ENCODED_BYTES + 1)).toThrowError(
			expect.objectContaining({ reason: "encoded-size" }),
		);
	});

	it("rejects encoded images before parsing when their byte length is unsafe", () => {
		expect(() => validateImageForDecode(new Uint8Array(MAX_IMAGE_ENCODED_BYTES + 1))).toThrowError(
			expect.objectContaining({ reason: "encoded-size" }),
		);
	});

	it("rejects zero dimensions from a recognized header", () => {
		expect(() => validateImageForDecode(png(0, 1))).toThrowError(expect.objectContaining({ reason: "dimensions" }));
	});

	it("rejects a header dimension over the per-axis limit", () => {
		expect(() => validateImageForDecode(png(MAX_IMAGE_DIMENSION + 1, 1))).toThrowError(
			expect.objectContaining({ reason: "dimensions" }),
		);
	});

	it("rejects dimensions whose decoded pixel count is unsafe", () => {
		const side = Math.floor(Math.sqrt(MAX_IMAGE_PIXELS)) + 1;
		expect(() => validateImageForDecode(png(side, side))).toThrowError(
			expect.objectContaining({ reason: "pixel-count" }),
		);
	});

	it("accepts supported headers and leaves unsupported formats for callers to omit", () => {
		expect(validateImageForDecode(png(100, 200))).toEqual({ width: 100, height: 200, format: "png" });
		expect(validateImageForDecode(Uint8Array.from([1, 2, 3]))).toBeNull();
	});
});
