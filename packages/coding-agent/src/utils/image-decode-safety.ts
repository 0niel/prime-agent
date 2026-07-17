import { imageSize } from "image-size";

/**
 * Limits apply to the encoded bytes passed to Photon, not to native clipboard
 * decoding performed upstream. A 32 MiB encoded image may coexist with its
 * roughly 43 MiB base64 representation. The pixel cap bounds one decoded RGBA
 * surface to about 100 MiB; Photon operations can temporarily allocate more.
 */
export const MAX_IMAGE_ENCODED_BYTES = 32 * 1024 * 1024;
export const MAX_IMAGE_DIMENSION = 16_384;
export const MAX_IMAGE_PIXELS = 25_000_000;

const MAX_IMAGE_BASE64_BYTES = Math.ceil((MAX_IMAGE_ENCODED_BYTES * 4) / 3) + 4;
const DECODE_SAFETY_FORMATS = new Set(["bmp", "gif", "jpg", "jpeg", "png", "webp"]);

function hasSupportedDecodeHeader(bytes: Uint8Array): boolean {
	const ascii = (offset: number, value: string): boolean =>
		value.split("").every((character, index) => bytes[offset + index] === character.charCodeAt(0));
	return (
		(bytes[0] === 0x89 && ascii(1, "PNG")) ||
		(bytes[0] === 0xff && bytes[1] === 0xd8) ||
		ascii(0, "GIF8") ||
		(ascii(0, "RIFF") && ascii(8, "WEBP")) ||
		ascii(0, "BM")
	);
}

export type ImageDecodeSafetyReason = "encoded-size" | "dimensions" | "pixel-count";

export interface ImageDimensions {
	width: number;
	height: number;
	format: "bmp" | "gif" | "jpeg" | "png" | "webp";
}

export class ImageDecodeSafetyError extends Error {
	readonly reason: ImageDecodeSafetyReason;

	constructor(reason: ImageDecodeSafetyReason, message: string) {
		super(message);
		this.name = "ImageDecodeSafetyError";
		this.reason = reason;
	}
}

/**
 * Read dimensions without decoding pixel data. Malformed images and formats we
 * do not pass to Photon return null and are omitted by callers.
 */
export function parseImageDimensions(bytes: Uint8Array): ImageDimensions | null {
	if (!hasSupportedDecodeHeader(bytes)) return null;
	try {
		const dimensions = imageSize(bytes);
		const format = dimensions.type?.toLowerCase();
		if (!format || !DECODE_SAFETY_FORMATS.has(format)) return null;

		return {
			width: dimensions.width,
			height: dimensions.height,
			format: format === "jpg" ? "jpeg" : (format as ImageDimensions["format"]),
		};
	} catch {
		return null;
	}
}

function encodedSizeError(): ImageDecodeSafetyError {
	return new ImageDecodeSafetyError(
		"encoded-size",
		`Image omitted: encoded input exceeds the safe decode limit of ${MAX_IMAGE_ENCODED_BYTES} bytes.`,
	);
}

export function assertImageEncodedSize(encodedBytes: number): void {
	if (encodedBytes > MAX_IMAGE_ENCODED_BYTES) {
		throw encodedSizeError();
	}
}

/** Reject obviously oversized base64 before allocating its decoded buffer. */
export function assertBase64ImageWithinEncodedLimit(data: string): void {
	if (Buffer.byteLength(data, "utf8") > MAX_IMAGE_BASE64_BYTES) {
		throw encodedSizeError();
	}
}

export function validateImageForDecode(bytes: Uint8Array): ImageDimensions | null {
	assertImageEncodedSize(bytes.byteLength);

	const dimensions = parseImageDimensions(bytes);
	if (!dimensions) return null;
	if (dimensions.width < 1 || dimensions.height < 1) {
		throw new ImageDecodeSafetyError("dimensions", "Image omitted: image dimensions must be positive.");
	}
	if (dimensions.width > MAX_IMAGE_DIMENSION || dimensions.height > MAX_IMAGE_DIMENSION) {
		throw new ImageDecodeSafetyError(
			"dimensions",
			`Image omitted: ${dimensions.width}x${dimensions.height} exceeds the safe decode dimension limit of ${MAX_IMAGE_DIMENSION}.`,
		);
	}
	if (dimensions.width > Math.floor(MAX_IMAGE_PIXELS / dimensions.height)) {
		throw new ImageDecodeSafetyError(
			"pixel-count",
			`Image omitted: ${dimensions.width}x${dimensions.height} exceeds the safe decode limit of ${MAX_IMAGE_PIXELS} pixels.`,
		);
	}
	return dimensions;
}
