import type { SpawnSyncReturns } from "child_process";
import { writeFileSync } from "fs";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { MAX_IMAGE_PIXELS } from "../src/utils/image-decode-safety.js";

const mocks = vi.hoisted(() => {
	return {
		spawnSync: vi.fn<(command: string, args: string[], options: unknown) => SpawnSyncReturns<Buffer>>(),
		clipboard: {
			hasImage: vi.fn<() => boolean>(),
			getImageBinary: vi.fn<() => Promise<Uint8Array | null>>(),
		},
	};
});

vi.mock("child_process", () => {
	return {
		spawnSync: mocks.spawnSync,
	};
});

vi.mock("../src/utils/clipboard-native.js", () => {
	return {
		clipboard: mocks.clipboard,
	};
});

function spawnOk(stdout: Buffer): SpawnSyncReturns<Buffer> {
	return {
		pid: 123,
		output: [Buffer.alloc(0), stdout, Buffer.alloc(0)],
		stdout,
		stderr: Buffer.alloc(0),
		status: 0,
		signal: null,
	};
}

function spawnError(error: Error): SpawnSyncReturns<Buffer> {
	return {
		pid: 123,
		output: [Buffer.alloc(0), Buffer.alloc(0), Buffer.alloc(0)],
		stdout: Buffer.alloc(0),
		stderr: Buffer.alloc(0),
		status: null,
		signal: null,
		error,
	};
}

function pngHeader(width = 1, height = 1): Buffer {
	const bytes = Buffer.alloc(24);
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
	bytes.writeUInt32BE(13, 8);
	bytes.write("IHDR", 12, "ascii");
	bytes.writeUInt32BE(width, 16);
	bytes.writeUInt32BE(height, 20);
	return bytes;
}

describe("readClipboardImage", () => {
	beforeEach(() => {
		vi.resetModules();
		mocks.spawnSync.mockReset();
		mocks.clipboard.hasImage.mockReset();
		mocks.clipboard.getImageBinary.mockReset();
	});

	test("Wayland: uses wl-paste and never calls clipboard", async () => {
		mocks.clipboard.hasImage.mockImplementation(() => {
			throw new Error("clipboard.hasImage should not be called on Wayland");
		});

		mocks.spawnSync.mockImplementation((command, args, _options) => {
			if (command === "wl-paste" && args[0] === "--list-types") {
				return spawnOk(Buffer.from("text/plain\nimage/png\n", "utf-8"));
			}
			if (command === "wl-paste" && args[0] === "--type") {
				return spawnOk(pngHeader());
			}
			throw new Error(`Unexpected spawnSync call: ${command} ${args.join(" ")}`);
		});

		const { readClipboardImage } = await import("../src/utils/clipboard-image.js");
		const result = await readClipboardImage({ platform: "linux", env: { WAYLAND_DISPLAY: "1" } });
		expect(result).not.toBeNull();
		expect(result?.mimeType).toBe("image/png");
		expect(result?.bytes).toEqual(pngHeader());
	});

	test("Wayland: falls back to xclip when wl-paste is missing", async () => {
		mocks.clipboard.hasImage.mockImplementation(() => {
			throw new Error("clipboard.hasImage should not be called on Wayland");
		});

		const enoent = new Error("spawn ENOENT");
		(enoent as { code?: string }).code = "ENOENT";

		mocks.spawnSync.mockImplementation((command, args, _options) => {
			if (command === "wl-paste") {
				return spawnError(enoent);
			}

			if (command === "xclip" && args.includes("TARGETS")) {
				return spawnOk(Buffer.from("image/png\n", "utf-8"));
			}

			if (command === "xclip" && args.includes("image/png")) {
				return spawnOk(pngHeader(2, 3));
			}

			return spawnOk(Buffer.alloc(0));
		});

		const { readClipboardImage } = await import("../src/utils/clipboard-image.js");
		const result = await readClipboardImage({ platform: "linux", env: { XDG_SESSION_TYPE: "wayland" } });
		expect(result).not.toBeNull();
		expect(result?.mimeType).toBe("image/png");
		expect(result?.bytes).toEqual(pngHeader(2, 3));
	});

	test("WSL: passes PowerShell path directly instead of through a custom env var", async () => {
		mocks.clipboard.hasImage.mockImplementation(() => {
			throw new Error("clipboard.hasImage should not be called before PowerShell on WSL");
		});

		let tmpFile: string | undefined;
		mocks.spawnSync.mockImplementation((command, args, options) => {
			if (command === "wl-paste" || command === "xclip") {
				return spawnOk(Buffer.alloc(0));
			}

			if (command === "wslpath") {
				tmpFile = args[1];
				return spawnOk(Buffer.from("C:\\Users\\O'Hare\\clip.png\n", "utf-8"));
			}

			if (command === "powershell.exe") {
				const spawnOptions = options as { env?: NodeJS.ProcessEnv };
				expect(spawnOptions.env?.PI_WSL_CLIPBOARD_IMAGE_PATH).toBeUndefined();
				expect(args[2]).toContain("$path = 'C:\\Users\\O''Hare\\clip.png'");
				if (!tmpFile) {
					throw new Error("wslpath should be called before powershell.exe");
				}
				writeFileSync(tmpFile, pngHeader(4, 5));
				return spawnOk(Buffer.from("ok\n", "utf-8"));
			}

			throw new Error(`Unexpected spawnSync call: ${command} ${args.join(" ")}`);
		});

		const { readClipboardImage } = await import("../src/utils/clipboard-image.js");
		const result = await readClipboardImage({ platform: "linux", env: { WSL_DISTRO_NAME: "Ubuntu" } });
		expect(result).not.toBeNull();
		expect(result?.mimeType).toBe("image/png");
		expect(Array.from(result?.bytes ?? [])).toEqual(Array.from(pngHeader(4, 5)));
	});

	test("Non-Wayland: uses clipboard", async () => {
		mocks.spawnSync.mockImplementation(() => {
			throw new Error("spawnSync should not be called for non-Wayland sessions");
		});

		mocks.clipboard.hasImage.mockReturnValue(true);
		mocks.clipboard.getImageBinary.mockResolvedValue(pngHeader(6, 7));

		const { readClipboardImage } = await import("../src/utils/clipboard-image.js");
		const result = await readClipboardImage({ platform: "linux", env: {} });
		expect(result).not.toBeNull();
		expect(result?.mimeType).toBe("image/png");
		expect(result?.bytes).toEqual(pngHeader(6, 7));
	});

	test("Non-Wayland: returns null when clipboard has no image", async () => {
		mocks.spawnSync.mockImplementation(() => {
			throw new Error("spawnSync should not be called for non-Wayland sessions");
		});

		mocks.clipboard.hasImage.mockReturnValue(false);

		const { readClipboardImage } = await import("../src/utils/clipboard-image.js");
		const result = await readClipboardImage({ platform: "linux", env: {} });
		expect(result).toBeNull();
	});
	test("rejects unsafe clipboard dimensions before returning the image", async () => {
		mocks.spawnSync.mockImplementation(() => {
			throw new Error("spawnSync should not be called for non-Wayland sessions");
		});
		mocks.clipboard.hasImage.mockReturnValue(true);
		const side = Math.floor(Math.sqrt(MAX_IMAGE_PIXELS)) + 1;
		mocks.clipboard.getImageBinary.mockResolvedValue(pngHeader(side, side));

		const { readClipboardImage } = await import("../src/utils/clipboard-image.js");
		await expect(readClipboardImage({ platform: "darwin", env: {} })).rejects.toMatchObject({
			reason: "pixel-count",
		});
	});
	test("surfaces clipboard command buffer exhaustion as a safety failure", async () => {
		mocks.clipboard.hasImage.mockImplementation(() => {
			throw new Error("clipboard.hasImage should not be called on Wayland");
		});
		const enobufs = new Error("spawnSync ENOBUFS");
		(enobufs as NodeJS.ErrnoException).code = "ENOBUFS";
		mocks.spawnSync.mockImplementation((command, args) => {
			if (command === "wl-paste" && args[0] === "--list-types") {
				return spawnOk(Buffer.from("image/png\n", "utf-8"));
			}
			return spawnError(enobufs);
		});

		const { readClipboardImage } = await import("../src/utils/clipboard-image.js");
		await expect(readClipboardImage({ platform: "linux", env: { WAYLAND_DISPLAY: "1" } })).rejects.toMatchObject({
			reason: "encoded-size",
		});
	});
});
