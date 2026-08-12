import * as childProcess from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { afterEach, describe, expect, it, vi } from "vitest";

const childProcessSpies = vi.hoisted(() => ({
	spawnSync: vi.fn(),
	originalSpawnSync: undefined as typeof import("node:child_process").spawnSync | undefined,
}));
const bootstrapSpies = vi.hoisted(() => ({
	ensureKernelPython: vi.fn(),
}));
vi.mock("../src/core/kernel/bootstrap.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/kernel/bootstrap.js")>();
	bootstrapSpies.ensureKernelPython.mockImplementation(actual.ensureKernelPython);
	return { ...actual, ensureKernelPython: bootstrapSpies.ensureKernelPython };
});
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	childProcessSpies.originalSpawnSync = actual.spawnSync;
	childProcessSpies.spawnSync.mockImplementation(actual.spawnSync);
	return { ...actual, spawnSync: childProcessSpies.spawnSync };
});

import { McpProjectDeclarationReader } from "../src/core/mcp/mcp-project-declaration-reader.js";
import {
	admitProjectMcpDeclarations,
	releaseProjectMcpDeclarationAdmission,
} from "../src/core/mcp/mcp-project-trust.js";
import { resolveTrustedProjectSettingsPython } from "../src/core/mcp/project-settings-openat.js";
import { createMcpProjectTrustAuthority } from "../src/core/mcp/project-trust-authority.js";

const cleanup: string[] = [];
const unavailable = "Project MCP declarations are unavailable.";

function root(): string {
	const path = mkdtempSync(join(realpathSync.native(tmpdir()), "project-openat-"));
	cleanup.push(path);
	return path;
}
function admission(path: string) {
	const grant = admitProjectMcpDeclarations(
		path,
		createMcpProjectTrustAuthority({ revision: "r1", allowedProjectDirectories: [path] }),
	);
	expect(grant).toBeDefined();
	return grant!;
}
function document() {
	return { version: 1 as const, servers: {} };
}

afterEach(() => {
	vi.restoreAllMocks();
	childProcessSpies.spawnSync.mockClear();
	while (cleanup.length) rmSync(cleanup.pop()!, { recursive: true, force: true });
});

describe("project settings openat", () => {
	it("redacts a rejected kernel bootstrap diagnostic", async () => {
		const diagnostic = "bootstrap secret: /private/kernel-python";
		bootstrapSpies.ensureKernelPython.mockRejectedValueOnce(new Error(diagnostic));

		let thrown: unknown;
		try {
			await resolveTrustedProjectSettingsPython();
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(Error);
		expect((thrown as Error).message).toBe(unavailable);
		expect(String(thrown)).not.toContain(diagnostic);
	});

	it("creates only below its retained root and preserves ordinary settings", async () => {
		const cwd = root();
		const grant = admission(cwd);
		try {
			const reader = await McpProjectDeclarationReader.create(grant);
			reader.setDocument(document());
			writeFileSync(join(cwd, ".prime", "agent", "settings.json"), JSON.stringify({ ordinary: { kept: true } }));
			reader.setDocument(document());
			expect(JSON.parse(readFileSync(join(cwd, ".prime", "agent", "settings.json"), "utf8"))).toMatchObject({
				ordinary: { kept: true },
				mcpDeclarations: { version: 1 },
			});
		} finally {
			releaseProjectMcpDeclarationAdmission(grant);
		}
	});

	it("treats absent project storage and an omitted declaration setting as an empty document", async () => {
		for (const setup of [
			(cwd: string) => cwd,
			(cwd: string) => {
				mkdirSync(join(cwd, ".prime", "agent"), { recursive: true });
				writeFileSync(join(cwd, ".prime", "agent", "settings.json"), JSON.stringify({ ordinary: true }));
				return cwd;
			},
		]) {
			const cwd = setup(root());
			const grant = admission(cwd);
			try {
				const reader = await McpProjectDeclarationReader.create(grant);
				expect(reader.getDocument()).toEqual(document());
			} finally {
				releaseProjectMcpDeclarationAdmission(grant);
			}
		}
	});

	it("fails closed for an explicitly null project declaration setting", async () => {
		const cwd = root();
		mkdirSync(join(cwd, ".prime", "agent"), { recursive: true });
		writeFileSync(join(cwd, ".prime", "agent", "settings.json"), JSON.stringify({ mcpDeclarations: null }));
		const grant = admission(cwd);
		try {
			const reader = await McpProjectDeclarationReader.create(grant);
			expect(() => reader.getDocument()).toThrow(unavailable);
		} finally {
			releaseProjectMcpDeclarationAdmission(grant);
		}
	});

	it("fails closed for component and leaf symlinks", async () => {
		for (const kind of ["prime", "agent", "leaf"] as const) {
			const cwd = root();
			const outside = root();
			if (kind === "prime") {
				symlinkSync(outside, join(cwd, ".prime"), "dir");
			} else {
				mkdirSync(join(cwd, ".prime", "agent"), { recursive: true });
				if (kind === "agent") {
					rmSync(join(cwd, ".prime", "agent"), { recursive: true });
					symlinkSync(outside, join(cwd, ".prime", "agent"), "dir");
				} else {
					symlinkSync(join(outside, "settings.json"), join(cwd, ".prime", "agent", "settings.json"));
				}
			}
			const grant = admission(cwd);
			try {
				const reader = await McpProjectDeclarationReader.create(grant);
				expect(() => reader.getDocument()).toThrow(unavailable);
				expect(() => reader.setDocument(document())).toThrow(unavailable);
			} finally {
				releaseProjectMcpDeclarationAdmission(grant);
			}
		}
	});

	it("fails closed for malformed, duplicate, and non-finite settings without exposing them", async () => {
		for (const raw of ["{", '{"ordinary":1,"ordinary":2}', '{"ordinary":NaN}', '{"ordinary":Infinity}']) {
			const cwd = root();
			mkdirSync(join(cwd, ".prime", "agent"), { recursive: true });
			writeFileSync(join(cwd, ".prime", "agent", "settings.json"), raw);
			const grant = admission(cwd);
			try {
				const reader = await McpProjectDeclarationReader.create(grant);
				expect(() => reader.getDocument()).toThrow(unavailable);
				expect(() => reader.setDocument(document())).toThrow(unavailable);
			} finally {
				releaseProjectMcpDeclarationAdmission(grant);
			}
		}
	});

	it("keeps a permanently replaced root untouched after validation", async () => {
		const cwd = root();
		const old = `${cwd}-old`;
		const replacement = `${cwd}-replacement`;
		cleanup.push(old, replacement);
		mkdirSync(join(replacement, ".prime", "agent"), { recursive: true });
		writeFileSync(
			join(replacement, ".prime", "agent", "settings.json"),
			JSON.stringify({ replacementSentinel: true }),
		);
		const grant = admission(cwd);
		const realSpawnSync = childProcessSpies.originalSpawnSync!;
		childProcessSpies.spawnSync.mockImplementationOnce(((...args: Parameters<typeof realSpawnSync>) => {
			renameSync(cwd, old);
			renameSync(replacement, cwd);
			return realSpawnSync(...args);
		}) as typeof childProcess.spawnSync);
		try {
			const reader = await McpProjectDeclarationReader.create(grant);
			expect(() => reader.setDocument(document())).toThrow(unavailable);
			expect(childProcessSpies.spawnSync).toHaveBeenCalledOnce();
			const options = childProcessSpies.spawnSync.mock.calls[0]![2]! as { shell?: unknown; stdio?: unknown };
			expect(options.shell).toBe(false);
			expect((options.stdio as unknown[])[3]).toEqual(expect.any(Number));
			expect(JSON.parse(readFileSync(join(cwd, ".prime", "agent", "settings.json"), "utf8"))).toEqual({
				replacementSentinel: true,
			});
		} finally {
			releaseProjectMcpDeclarationAdmission(grant);
		}
	});

	it("interoperates with the ordinary settings lock and preserves independent updates", async () => {
		const cwd = root();
		const agentDir = join(cwd, ".prime", "agent");
		const settings = join(agentDir, "settings.json");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(settings, JSON.stringify({ ordinary: { before: true } }));
		const grant = admission(cwd);
		try {
			const reader = await McpProjectDeclarationReader.create(grant);
			const release = lockfile.lockSync(settings, { realpath: false });
			try {
				expect(() => reader.setDocument(document())).toThrow(unavailable);
				expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual({ ordinary: { before: true } });
				expect(lstatSync(`${settings}.lock`).isDirectory()).toBe(true);
			} finally {
				release();
			}

			reader.setDocument(document());
			expect(existsSync(`${settings}.lock`)).toBe(false);
			expect(JSON.parse(readFileSync(settings, "utf8"))).toMatchObject({
				ordinary: { before: true },
				mcpDeclarations: { version: 1 },
			});
			const releaseAfter = lockfile.lockSync(settings, { realpath: false });
			releaseAfter();
		} finally {
			releaseProjectMcpDeclarationAdmission(grant);
		}
	});

	it("makes a helper-protocol lock visible to the ordinary settings writer", () => {
		const cwd = root();
		const agentDir = join(cwd, ".prime", "agent");
		const settings = join(agentDir, "settings.json");
		const lock = `${settings}.lock`;
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(settings, JSON.stringify({ ordinary: true }));
		mkdirSync(lock, { mode: 0o700 });
		try {
			expect(() => lockfile.lockSync(settings, { realpath: false })).toThrow();
			expect(lstatSync(lock).isDirectory()).toBe(true);
		} finally {
			rmdirSync(lock);
		}
		const release = lockfile.lockSync(settings, { realpath: false });
		release();
	});

	it("serializes a concurrent ordinary settings update without clobbering either field", async () => {
		const cwd = root();
		const agentDir = join(cwd, ".prime", "agent");
		const settings = join(agentDir, "settings.json");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(settings, JSON.stringify({ ordinary: { before: true } }));
		const worker = childProcess.spawn(
			process.execPath,
			[
				"-e",
				`const fs=require("node:fs");const lock=require("proper-lockfile");const p=${JSON.stringify(settings)};const release=lock.lockSync(p,{realpath:false});setTimeout(()=>{const d=JSON.parse(fs.readFileSync(p,"utf8"));d.ordinary={concurrent:true};fs.writeFileSync(p,JSON.stringify(d));release();},100);`,
			],
			{ cwd: process.cwd(), stdio: "ignore" },
		);
		const workerExit = new Promise<number | null>((resolve) => worker.once("exit", resolve));
		const waitUntil = Date.now() + 2_000;
		while (!existsSync(`${settings}.lock`) && Date.now() < waitUntil) {
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
		}
		expect(existsSync(`${settings}.lock`)).toBe(true);
		const grant = admission(cwd);
		try {
			const reader = await McpProjectDeclarationReader.create(grant);
			reader.setDocument(document());
			expect(await workerExit).toBe(0);
			expect(JSON.parse(readFileSync(settings, "utf8"))).toMatchObject({
				ordinary: { concurrent: true },
				mcpDeclarations: { version: 1 },
			});
		} finally {
			releaseProjectMcpDeclarationAdmission(grant);
		}
	});

	it("removes its owned lock after a transactional helper failure", async () => {
		const cwd = root();
		const agentDir = join(cwd, ".prime", "agent");
		const settings = join(agentDir, "settings.json");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(settings, "{");
		const grant = admission(cwd);
		try {
			const reader = await McpProjectDeclarationReader.create(grant);
			expect(() => reader.setDocument(document())).toThrow(unavailable);
			expect(existsSync(`${settings}.lock`)).toBe(false);
			expect(readFileSync(settings, "utf8")).toBe("{");
		} finally {
			releaseProjectMcpDeclarationAdmission(grant);
		}
	});

	it("fails closed for hostile lock leaves without changing settings or outside targets", async () => {
		for (const kind of ["regular", "symlink"] as const) {
			const cwd = root();
			const outside = root();
			const agentDir = join(cwd, ".prime", "agent");
			const settings = join(agentDir, "settings.json");
			const lock = `${settings}.lock`;
			mkdirSync(agentDir, { recursive: true });
			writeFileSync(settings, JSON.stringify({ ordinary: true }));
			if (kind === "regular") writeFileSync(lock, "legacy lock");
			else symlinkSync(outside, lock, "dir");
			const grant = admission(cwd);
			try {
				const reader = await McpProjectDeclarationReader.create(grant);
				expect(() => reader.setDocument(document())).toThrow(unavailable);
				expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual({ ordinary: true });
				expect(lstatSync(lock).isSymbolicLink()).toBe(kind === "symlink");
				expect(readFileSync(settings, "utf8")).not.toContain(outside);
			} finally {
				releaseProjectMcpDeclarationAdmission(grant);
			}
		}
	});

	it("bounds helper input/output, redacts all child failure detail, and closes a released grant", async () => {
		const cwd = root();
		const grant = admission(cwd);
		try {
			const reader = await McpProjectDeclarationReader.create(grant);
			const spawn = vi.spyOn(childProcess, "spawnSync").mockReturnValue({
				status: 1,
				stdout: "secret settings path and child stderr",
				stderr: "secret",
			} as ReturnType<typeof childProcess.spawnSync>);
			expect(() => reader.getDocument()).toThrow(unavailable);
			expect(() => reader.getDocument()).not.toThrow(/secret/);
			expect(spawn.mock.calls[0]![1]).toEqual(["-I", "-c", expect.any(String)]);
			releaseProjectMcpDeclarationAdmission(grant);
			expect(() => reader.getDocument()).toThrow(unavailable);
		} finally {
			releaseProjectMcpDeclarationAdmission(grant);
		}
	});
});
