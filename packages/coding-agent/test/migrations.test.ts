import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.js";
import {
	migrateAuthToAuthJson,
	migrateLegacySessionDirsToSessionRoot,
	migrateSessionsFromAgentRoot,
} from "../src/migrations.js";

describe("session migrations", () => {
	const tempDirs: string[] = [];
	const previousAgentDir = process.env[ENV_AGENT_DIR];

	afterEach(() => {
		if (previousAgentDir === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = previousAgentDir;
		}
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("moves legacy per-cwd session files into the flat session root", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "prime-agent-migrations-"));
		tempDirs.push(agentDir);
		process.env[ENV_AGENT_DIR] = agentDir;

		const sessionsDir = join(agentDir, "sessions");
		const legacyDir = join(sessionsDir, "--tmp-project--");
		mkdirSync(legacyDir, { recursive: true });
		const legacyFile = join(legacyDir, "session-1.jsonl");
		const sessionLines = [
			{
				type: "session",
				version: 3,
				id: "session-1",
				timestamp: new Date().toISOString(),
				cwd: "/tmp/project",
			},
			{
				type: "message",
				id: "entry-1",
				parentId: null,
				timestamp: new Date().toISOString(),
				message: { role: "user", content: "hello", timestamp: Date.now() },
			},
		];
		writeFileSync(legacyFile, `${sessionLines.map((line) => JSON.stringify(line)).join("\n")}\n`);

		migrateLegacySessionDirsToSessionRoot();

		const migratedFile = join(sessionsDir, "session-1.jsonl");
		expect(existsSync(legacyFile)).toBe(false);
		expect(existsSync(legacyDir)).toBe(false);
		expect(readFileSync(migratedFile, "utf8")).toContain('"id":"session-1"');
	});

	it("moves root session files using only the JSONL header", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "prime-agent-migrations-"));
		tempDirs.push(agentDir);
		process.env[ENV_AGENT_DIR] = agentDir;

		const legacyFile = join(agentDir, "session-root.jsonl");
		writeFileSync(
			legacyFile,
			`${JSON.stringify({
				type: "session",
				version: 3,
				id: "session-root",
				timestamp: new Date().toISOString(),
				cwd: "/tmp/project",
			})}\n${"x".repeat(128 * 1024)}\n`,
		);

		migrateSessionsFromAgentRoot();

		const migratedFile = join(agentDir, "sessions", "session-root.jsonl");
		expect(existsSync(legacyFile)).toBe(false);
		expect(readFileSync(migratedFile, "utf8")).toContain('"id":"session-root"');
	});

	it("does not move session files from non-legacy subdirectories", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "prime-agent-migrations-"));
		tempDirs.push(agentDir);
		process.env[ENV_AGENT_DIR] = agentDir;

		const sessionsDir = join(agentDir, "sessions");
		const nonLegacyDir = join(sessionsDir, "exports");
		mkdirSync(nonLegacyDir, { recursive: true });
		const nestedFile = join(nonLegacyDir, "session-2.jsonl");
		writeFileSync(
			nestedFile,
			`${JSON.stringify({
				type: "session",
				version: 3,
				id: "session-2",
				timestamp: new Date().toISOString(),
				cwd: "/tmp/project",
			})}\n`,
		);

		migrateLegacySessionDirsToSessionRoot();

		expect(existsSync(nestedFile)).toBe(true);
		expect(existsSync(join(sessionsDir, "session-2.jsonl"))).toBe(false);
	});
});

describe("auth migration", () => {
	const tempDirs: string[] = [];
	const previousAgentDir = process.env[ENV_AGENT_DIR];

	afterEach(() => {
		if (previousAgentDir === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = previousAgentDir;
		}
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	function createAgentDir(): string {
		const agentDir = mkdtempSync(join(tmpdir(), "prime-agent-auth-migration-"));
		tempDirs.push(agentDir);
		process.env[ENV_AGENT_DIR] = agentDir;
		return agentDir;
	}

	it("commits auth.json before cleaning both legacy credential sources", () => {
		const agentDir = createAgentDir();
		const oauthPath = join(agentDir, "oauth.json");
		const settingsPath = join(agentDir, "settings.json");
		const authPath = join(agentDir, "auth.json");
		writeFileSync(oauthPath, JSON.stringify({ anthropic: { access: "access", refresh: "refresh", expires: 123 } }));
		writeFileSync(settingsPath, JSON.stringify({ theme: "dark", apiKeys: { openai: "openai-key" } }));

		expect(migrateAuthToAuthJson()).toEqual(["anthropic", "openai"]);

		expect(JSON.parse(readFileSync(authPath, "utf-8"))).toEqual({
			anthropic: { type: "oauth", access: "access", refresh: "refresh", expires: 123 },
			openai: { type: "api_key", key: "openai-key" },
		});
		expect(statSync(authPath).mode & 0o777).toBe(0o600);
		expect(existsSync(oauthPath)).toBe(false);
		expect(existsSync(`${oauthPath}.migrated`)).toBe(true);
		expect(JSON.parse(readFileSync(settingsPath, "utf-8"))).toEqual({ theme: "dark" });
	});

	it.runIf(process.platform !== "win32")("keeps committed auth when legacy settings cleanup cannot be written", () => {
		const agentDir = createAgentDir();
		const protectedDir = join(agentDir, "protected");
		const settingsTarget = join(protectedDir, "settings.json");
		mkdirSync(protectedDir);
		writeFileSync(settingsTarget, JSON.stringify({ apiKeys: { openai: "openai-key" } }));
		symlinkSync(settingsTarget, join(agentDir, "settings.json"));
		chmodSync(protectedDir, 0o500);
		try {
			expect(migrateAuthToAuthJson()).toEqual(["openai"]);
			expect(JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf-8"))).toEqual({
				openai: { type: "api_key", key: "openai-key" },
			});
			expect(JSON.parse(readFileSync(settingsTarget, "utf-8"))).toEqual({
				apiKeys: { openai: "openai-key" },
			});
		} finally {
			chmodSync(protectedDir, 0o700);
		}
	});

	it("recovers OAuth credentials from a legacy backup left by an interrupted migration", () => {
		const agentDir = createAgentDir();
		const migratedOauthPath = join(agentDir, "oauth.json.migrated");
		writeFileSync(
			migratedOauthPath,
			JSON.stringify({ google: { access: "access", refresh: "refresh", expires: 456 } }),
		);

		expect(migrateAuthToAuthJson()).toEqual(["google"]);
		expect(JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf-8"))).toEqual({
			google: { type: "oauth", access: "access", refresh: "refresh", expires: 456 },
		});
		expect(existsSync(migratedOauthPath)).toBe(true);
		expect(existsSync(join(agentDir, "settings.json"))).toBe(false);
	});

	it("leaves legacy sources untouched when auth.json is already authoritative", () => {
		const agentDir = createAgentDir();
		const authPath = join(agentDir, "auth.json");
		const oauthPath = join(agentDir, "oauth.json");
		const settingsPath = join(agentDir, "settings.json");
		writeFileSync(authPath, JSON.stringify({ existing: { type: "api_key", key: "existing-key" } }));
		writeFileSync(oauthPath, JSON.stringify({ google: { access: "legacy" } }));
		writeFileSync(settingsPath, JSON.stringify({ apiKeys: { openai: "legacy-key" } }));

		expect(migrateAuthToAuthJson()).toEqual([]);
		expect(JSON.parse(readFileSync(authPath, "utf-8"))).toEqual({
			existing: { type: "api_key", key: "existing-key" },
		});
		expect(existsSync(oauthPath)).toBe(true);
		expect(JSON.parse(readFileSync(settingsPath, "utf-8"))).toEqual({
			apiKeys: { openai: "legacy-key" },
		});
	});
});
