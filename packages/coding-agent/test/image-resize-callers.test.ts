import { closeSync, ftruncateSync, mkdirSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/utils/image-resize.js", () => ({
	resizeImage: vi.fn(),
	formatDimensionNote: vi.fn(() => undefined),
}));

import { processFileArguments } from "../src/cli/file-processor.js";
import { ImageDecodeSafetyError, MAX_IMAGE_ENCODED_BYTES } from "../src/utils/image-decode-safety.js";
import { resizeImage } from "../src/utils/image-resize.js";

const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

describe("image resize callers", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `image-resize-callers-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
		vi.mocked(resizeImage).mockReset();
		vi.mocked(resizeImage).mockResolvedValue(null);
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("file processor omits image attachments when auto-resize cannot produce a safe image", async () => {
		const imagePath = join(testDir, "test.png");
		writeFileSync(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));

		const result = await processFileArguments([imagePath]);

		expect(result.images).toHaveLength(0);
		expect(result.text).toContain("Image omitted");
	});
	it("file processor rejects an oversized image from stat before resizing", async () => {
		const imagePath = join(testDir, "oversized.png");
		writeFileSync(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));
		const fd = openSync(imagePath, "r+");
		try {
			ftruncateSync(fd, MAX_IMAGE_ENCODED_BYTES + 1);
		} finally {
			closeSync(fd);
		}

		const result = await processFileArguments([imagePath]);

		expect(result.images).toHaveLength(0);
		expect(result.text).toContain("encoded input exceeds");
		expect(resizeImage).not.toHaveBeenCalled();
	});

	it("file processor reports safety-limit rejection separately", async () => {
		const imagePath = join(testDir, "unsafe.png");
		writeFileSync(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));
		vi.mocked(resizeImage).mockRejectedValue(
			new ImageDecodeSafetyError("pixel-count", "Image omitted: dimensions exceed the safe decode limit."),
		);

		const result = await processFileArguments([imagePath]);

		expect(result.images).toHaveLength(0);
		expect(result.text).toContain("safe decode limit");
		expect(result.text).not.toContain("could not be resized");
	});
});
