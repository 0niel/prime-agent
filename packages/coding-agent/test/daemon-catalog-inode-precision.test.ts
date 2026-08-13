import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const fsMocks = vi.hoisted(() => ({
	lstatSync: vi.fn<typeof import("node:fs").lstatSync>(),
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	fsMocks.lstatSync.mockImplementation(actual.lstatSync);
	return { ...actual, lstatSync: fsMocks.lstatSync };
});

const { listCatalogFamilySessions, setCatalogHelperLaunchForTest } = await import(
	"../src/modes/daemon/daemon-catalog-process.js"
);

const UNSAFE_INODE = 9_007_199_254_740_993n;
const SESSION_HEADER = `${JSON.stringify({
	type: "session",
	id: "parent",
	timestamp: "2026-01-01T00:00:00.000Z",
	cwd: "/tmp/project",
	rlmDepth: 0,
})}\n`;

function helperForInode(ino: bigint): string {
	return `
let input = "";
process.stdin.on("data", (chunk) => {
	input += chunk;
	while (true) {
		const newline = input.indexOf("\\n");
		if (newline === -1) return;
		const request = JSON.parse(input.slice(0, newline));
		input = input.slice(newline + 1);
		const response = { id: request.id, mtimeMs: 0, dev: "1", ino: "${ino}" };
		if (request.mode === "metadata") {
			response.data = {
				valid: true,
				messageCount: 0,
				firstMessage: "(no messages)",
				allMessagesText: "",
				modifiedMs: 0,
			};
		} else if (request.mode !== "stat") {
			response.data = "${Buffer.from(SESSION_HEADER).toString("base64")}";
		}
		process.stdout.write(JSON.stringify(response) + "\\n");
	}
});
`;
}

function mockUnsafeInode(sessionFile: string): void {
	fsMocks.lstatSync.mockImplementation(((path: string, options?: { bigint?: boolean }) => {
		if (path !== sessionFile) throw new Error(`unexpected lstat path: ${path}`);
		return options?.bigint === true
			? ({ dev: 1n, ino: UNSAFE_INODE } as ReturnType<typeof fsMocks.lstatSync>)
			: ({ dev: 1, ino: Number(UNSAFE_INODE) } as ReturnType<typeof fsMocks.lstatSync>);
	}) as never);
}

function createFixture() {
	const root = mkdtempSync(join(tmpdir(), "prime-catalog-unsafe-inode-"));
	const sessionDir = join(root, "sessions");
	const sessionFile = join(sessionDir, "parent.jsonl");
	mkdirSync(sessionDir);
	writeFileSync(sessionFile, SESSION_HEADER);
	return { root, sessionDir, sessionFile };
}

afterEach(() => {
	setCatalogHelperLaunchForTest(undefined);
	fsMocks.lstatSync.mockReset();
});

describe("daemon catalog root identity", () => {
	it("matches an unsafe inode from lstat to the helper's exact fstat decimal", async () => {
		const { root, sessionDir, sessionFile } = createFixture();
		mockUnsafeInode(sessionFile);
		setCatalogHelperLaunchForTest({ command: process.execPath, args: ["-e", helperForInode(UNSAFE_INODE)] });

		try {
			await expect(listCatalogFamilySessions(sessionDir)).resolves.toEqual([
				expect.objectContaining({ id: "parent" }),
			]);
			expect(fsMocks.lstatSync).toHaveBeenCalledWith(sessionFile, { bigint: true });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects an unsafe inode differing from the helper below Number precision", async () => {
		const { root, sessionDir, sessionFile } = createFixture();
		mockUnsafeInode(sessionFile);
		setCatalogHelperLaunchForTest({
			command: process.execPath,
			args: ["-e", helperForInode(UNSAFE_INODE - 1n)],
		});

		try {
			await expect(listCatalogFamilySessions(sessionDir)).rejects.toThrow(
				"root candidate changed after directory enumeration",
			);
			expect(fsMocks.lstatSync).toHaveBeenCalledWith(sessionFile, { bigint: true });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
