import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, existsSync, readFileSync } from "node:fs";
import { access, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stderr, stdin } from "node:process";
import { createInterface } from "node:readline/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { getPackageDir } from "../../config.js";
import type { PythonSkillRuntimeInfo } from "../skills.js";

const BOOTSTRAP_SCHEMA = 7;
const PYTHON_VERSION = "3.11";
const IPYKERNEL_REQUIREMENT = "ipykernel";
const RUNTIME_REQUIREMENT = "prime-agent-runtime";
// Serializes the kernel's user namespace so it can be revived across session
// resume. Internal-only; intentionally not surfaced to the model as an import.
const STATE_SNAPSHOT_REQUIREMENT = "dill";
const DEFAULT_RLM_EXTRA_PACKAGES = [
	{ uvArg: "requests", importName: "requests", promptLabel: "requests" },
	{ uvArg: "httpx", importName: "httpx", promptLabel: "httpx" },
	{ uvArg: "pyyaml", importName: "yaml", promptLabel: "yaml (PyYAML)" },
	{ uvArg: "tomli", importName: "tomli", promptLabel: "tomli" },
	{ uvArg: "python-dotenv", importName: "dotenv", promptLabel: "dotenv (python-dotenv)" },
	{ uvArg: "pandas", importName: "pandas", promptLabel: "pandas" },
	{ uvArg: "numpy", importName: "numpy", promptLabel: "numpy" },
	{ uvArg: "scipy", importName: "scipy", promptLabel: "scipy" },
	{ uvArg: "beautifulsoup4", importName: "bs4", promptLabel: "bs4 (Beautiful Soup)" },
	{ uvArg: "lxml", importName: "lxml", promptLabel: "lxml" },
	{ uvArg: "pydantic", importName: "pydantic", promptLabel: "pydantic" },
	{ uvArg: "tyro", importName: "tyro", promptLabel: "tyro" },
];
export const DEFAULT_RLM_EXTRA_UV_ARGS = DEFAULT_RLM_EXTRA_PACKAGES.map((pkg) => pkg.uvArg);
export const DEFAULT_RLM_EXTRA_IMPORT_NAMES = DEFAULT_RLM_EXTRA_PACKAGES.map((pkg) => pkg.importName);
export const DEFAULT_RLM_EXTRA_IMPORT_LABELS = DEFAULT_RLM_EXTRA_PACKAGES.map((pkg) => pkg.promptLabel);
const UV_INSTALL_COMMAND = "curl -LsSf https://astral.sh/uv/install.sh | sh";
const REQUIRED_HARNESS_METHODS = [
	"create_memory",
	"update_memory",
	"delete_memory",
	"create_skill",
	"update_skill",
	"delete_skill",
	"create_subagent",
	"update_subagent",
	"delete_subagent",
	"create_prompt_note",
	"update_prompt_note",
	"delete_prompt_note",
	"record_refinement",
];
const RUNTIME_READY_CHECK = `import inspect; import rlm; from rlm.harness import HarnessEntry; _harness_methods = ${JSON.stringify(REQUIRED_HARNESS_METHODS)}; assert hasattr(rlm, 'run'); assert callable(rlm); assert hasattr(rlm, 'rlm'); assert callable(rlm.rlm); assert callable(rlm.host_request); assert hasattr(rlm, 'harness'); assert hasattr(rlm, 'get_harness_state'); assert hasattr(rlm.rlm, 'harness'); assert hasattr(rlm.rlm, 'get_harness_state'); assert all(callable(getattr(_harness, _method, None)) for _harness in (rlm.harness, rlm.rlm.harness) for _method in _harness_methods); assert 'reference' in HarnessEntry.__dataclass_fields__; assert 'reference' in inspect.signature(rlm.harness.create_skill).parameters; assert 'reference' in inspect.signature(rlm.harness.update_skill).parameters; assert not hasattr(rlm, 'background'); assert not hasattr(rlm.rlm, 'background')`;
const BOOTSTRAP_VERSION_FILE = ".bootstrap-version";
const BOOTSTRAP_LOCK_NAME = ".bootstrap.lock";
const BOOTSTRAP_LOCK_RETRY_MS = 100;
const BOOTSTRAP_LOCK_STALE_WITHOUT_PID_MS = 30_000;

let inFlightEnsureKernelPython: { key: string; promise: Promise<string> } | null = null;

export type KernelPythonSkill = PythonSkillRuntimeInfo;
export type KernelBootstrapProgressHandler = (message: string) => void;

export interface EnsureKernelPythonOptions {
	pythonSkills?: readonly KernelPythonSkill[];
	onProgress?: KernelBootstrapProgressHandler;
}

interface BootstrapPythonSkill {
	importName: string;
	packagePath: string;
	pyprojectPath: string;
	pyprojectHash: string;
}

interface BootstrapVersion {
	schema: number;
	ipykernel?: string;
	runtime?: string;
	snapshot?: string;
	extraUvArgs?: string[];
	pythonSkills?: BootstrapPythonSkill[];
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isNodeError(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function exists(filePath: string): Promise<boolean> {
	try {
		await access(filePath);
		return true;
	} catch {
		return false;
	}
}

async function isExecutable(filePath: string): Promise<boolean> {
	try {
		await access(filePath, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function expandHome(filePath: string): string {
	if (filePath === "~") return os.homedir();
	if (filePath.startsWith("~/")) return path.join(os.homedir(), filePath.slice(2));
	return filePath;
}

function fileContentHash(filePath: string): string {
	try {
		return `sha256:${createHash("sha256").update(readFileSync(filePath)).digest("hex")}`;
	} catch {
		return "unreadable";
	}
}

function normalizePythonSkills(pythonSkills: readonly KernelPythonSkill[] | undefined): BootstrapPythonSkill[] {
	const byKey = new Map<string, BootstrapPythonSkill>();
	for (const skill of pythonSkills ?? []) {
		const packagePath = path.resolve(skill.packagePath);
		const pyprojectPath = path.resolve(skill.pyprojectPath);
		const key = `${skill.importName}\0${packagePath}`;
		byKey.set(key, {
			importName: skill.importName,
			packagePath,
			pyprojectPath,
			pyprojectHash: fileContentHash(pyprojectPath),
		});
	}
	return [...byKey.values()].sort((a, b) => {
		const packageCompare = a.packagePath.localeCompare(b.packagePath);
		if (packageCompare !== 0) return packageCompare;
		return a.importName.localeCompare(b.importName);
	});
}

function ensureKernelPythonKey(pythonSkills: readonly BootstrapPythonSkill[]): string {
	return [
		process.env.PRIME_AGENT_KERNEL_PYTHON ?? "",
		process.env.PRIME_AGENT_KERNEL_VENV ?? "",
		process.env.HOME ?? "",
		process.env.XDG_DATA_HOME ?? "",
		JSON.stringify(pythonSkills),
	].join("\0");
}

export function getKernelVenvDir(): string {
	const override = process.env.PRIME_AGENT_KERNEL_VENV;
	if (override) return path.resolve(expandHome(override));
	return path.join(os.homedir(), ".prime", "agent", "kernel-venv");
}

function getXdgKernelVenvDir(): string {
	const dataHome = process.env.XDG_DATA_HOME
		? path.resolve(expandHome(process.env.XDG_DATA_HOME))
		: path.join(os.homedir(), ".local", "share");
	return path.join(dataHome, "prime", "agent", "kernel-venv");
}

async function resolveWritableKernelVenvDir(): Promise<string> {
	const primary = getKernelVenvDir();
	try {
		await mkdir(path.dirname(primary), { recursive: true });
		return primary;
	} catch (primaryError) {
		if (process.env.PRIME_AGENT_KERNEL_VENV) {
			throw new Error(`couldn't create kernel venv parent directory for ${primary}: ${errorMessage(primaryError)}`);
		}

		const fallback = getXdgKernelVenvDir();
		try {
			await mkdir(path.dirname(fallback), { recursive: true });
			return fallback;
		} catch (fallbackError) {
			throw new Error(
				`couldn't create kernel venv directory at ${primary} or ${fallback}; set PRIME_AGENT_KERNEL_PYTHON to a python with ipykernel installed. ${errorMessage(fallbackError)}`,
			);
		}
	}
}

function run(command: string, args: string[], options: { stdio?: "ignore" | "inherit" } = {}): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			env: process.env,
			stdio: options.stdio ?? "ignore",
		});
		child.on("error", reject);
		child.on("exit", (code, signal) => {
			if (code === 0) {
				resolve();
				return;
			}
			const reason = signal ? `signal ${signal}` : `exit code ${code}`;
			reject(new Error(`${command} ${args.join(" ")} failed with ${reason}`));
		});
	});
}

async function pythonImports(python: string, moduleName: string): Promise<boolean> {
	try {
		await run(python, ["-c", `import ${moduleName}`], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

async function hasIpykernel(python: string): Promise<boolean> {
	return pythonImports(python, "ipykernel");
}

async function hasPrimeAgentRuntime(python: string): Promise<boolean> {
	try {
		await run(python, ["-c", RUNTIME_READY_CHECK], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

async function missingRlmExtraImportLabels(python: string): Promise<string[]> {
	const missing: string[] = [];
	for (const pkg of DEFAULT_RLM_EXTRA_PACKAGES) {
		if (!(await pythonImports(python, pkg.importName))) {
			missing.push(pkg.promptLabel);
		}
	}
	return missing;
}

async function missingPythonSkillImportLabels(
	python: string,
	pythonSkills: readonly KernelPythonSkill[],
): Promise<string[]> {
	const missing: string[] = [];
	for (const skill of pythonSkills) {
		if (!(await pythonImports(python, skill.importName))) {
			missing.push(`${skill.name} (${skill.importName})`);
		}
	}
	return missing;
}

function reportProgress(options: EnsureKernelPythonOptions, message: string): void {
	if (options.onProgress) {
		options.onProgress(message);
		return;
	}
	process.stderr.write(`${message}\n`);
}

// Drives the single setup line shown during first-run bootstrap: each step
// replaces the line with what's actually running plus a cumulative percentage.
// Weights are rough wall-clock shares (the package install dwarfs the rest) so
// the percentage tracks real work, not a flat 1/N. The caller builds the step
// list from only the steps that will run, so the denominator stays honest.
interface BootstrapStep {
	label: string;
	weight: number;
}

class BootstrapProgress {
	private readonly total: number;
	private completedWeight = 0;

	constructor(
		private readonly options: EnsureKernelPythonOptions,
		steps: readonly BootstrapStep[],
	) {
		this.total = steps.reduce((sum, step) => sum + step.weight, 0) || 1;
	}

	// Announce a step as it begins; the percentage reflects work done before it.
	begin(step: BootstrapStep): void {
		const percent = Math.min(99, Math.round((this.completedWeight / this.total) * 100));
		this.completedWeight += step.weight;
		reportProgress(this.options, `${step.label} · ${percent}%`);
	}
}

const BOOTSTRAP_STEP = {
	uv: { label: "installing uv", weight: 3 },
	python: { label: "installing Python 3.11", weight: 4 },
	venv: { label: "creating virtual environment", weight: 2 },
	packages: { label: "installing packages (ipykernel, numpy, pandas, …)", weight: 10 },
	skills: { label: "installing Python skills", weight: 2 },
} satisfies Record<string, BootstrapStep>;

function bootstrapLockDir(venv: string): string {
	return path.join(path.dirname(venv), `${path.basename(venv)}${BOOTSTRAP_LOCK_NAME}`);
}

function processIsRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return isNodeError(error, "EPERM");
	}
}

async function readLockPid(lockDir: string): Promise<number | null> {
	try {
		const raw = await readFile(path.join(lockDir, "pid"), "utf8");
		const pid = Number.parseInt(raw.trim(), 10);
		return Number.isInteger(pid) && pid > 0 ? pid : null;
	} catch {
		return null;
	}
}

async function lockMissingPidIsStale(lockDir: string): Promise<boolean> {
	try {
		const lockStat = await stat(lockDir);
		return Date.now() - lockStat.mtimeMs > BOOTSTRAP_LOCK_STALE_WITHOUT_PID_MS;
	} catch {
		return false;
	}
}

async function acquireBootstrapLock(venv: string): Promise<() => Promise<void>> {
	const lockDir = bootstrapLockDir(venv);
	await mkdir(path.dirname(lockDir), { recursive: true });

	for (;;) {
		try {
			await mkdir(lockDir);
			await writeFile(path.join(lockDir, "pid"), `${process.pid}\n`, "utf8");
			return () => rm(lockDir, { recursive: true, force: true });
		} catch (error) {
			if (!isNodeError(error, "EEXIST")) throw error;

			const pid = await readLockPid(lockDir);
			if (pid === null ? await lockMissingPidIsStale(lockDir) : !processIsRunning(pid)) {
				await rm(lockDir, { recursive: true, force: true });
				continue;
			}

			await sleep(BOOTSTRAP_LOCK_RETRY_MS);
		}
	}
}

async function findExecutable(name: string): Promise<string | null> {
	const pathValue = process.env.PATH;
	if (!pathValue) return null;
	const candidates = process.platform === "win32" ? [name, `${name}.exe`] : [name];
	for (const dir of pathValue.split(path.delimiter)) {
		if (!dir) continue;
		for (const candidate of candidates) {
			const fullPath = path.join(dir, candidate);
			if (await isExecutable(fullPath)) return fullPath;
		}
	}
	return null;
}

function localUvPath(): string {
	return path.join(os.homedir(), ".local", "bin", process.platform === "win32" ? "uv.exe" : "uv");
}

// Resolve an existing uv without installing one. Returns null if uv is absent.
async function locateUv(): Promise<string | null> {
	const fromPath = await findExecutable("uv");
	if (fromPath) return fromPath;
	const localUv = localUvPath();
	return (await isExecutable(localUv)) ? localUv : null;
}

async function ensureUv(options: EnsureKernelPythonOptions, onAboutToInstall?: () => void): Promise<string> {
	const existing = await locateUv();
	if (existing) return existing;

	const localUv = localUvPath();
	const shouldInstallUv =
		process.env.PRIME_AGENT_INSTALL_UV === "1" || (!options.onProgress && (await confirmUvInstall()));
	if (!shouldInstallUv) {
		throw new Error(
			`uv is required to set up the Python kernel. Install uv yourself: ${UV_INSTALL_COMMAND}, ` +
				"or set PRIME_AGENT_INSTALL_UV=1 to let prime-agent run that installer.",
		);
	}

	// Announce only once an install is actually committed, so a refusal here never
	// leaves a phantom "installing uv" step on screen.
	onAboutToInstall?.();

	try {
		await run("sh", ["-c", UV_INSTALL_COMMAND], { stdio: options.onProgress ? "ignore" : "inherit" });
	} catch (error) {
		throw new Error(
			`couldn't install uv from astral.sh; install it yourself: ${UV_INSTALL_COMMAND}, then re-run prime-agent. ${errorMessage(error)}`,
		);
	}

	if (await isExecutable(localUv)) return localUv;
	const installedFromPath = await findExecutable("uv");
	if (installedFromPath) return installedFromPath;
	throw new Error("uv install completed but binary not found at ~/.local/bin/uv");
}

async function confirmUvInstall(): Promise<boolean> {
	if (process.env.PRIME_AGENT_INSTALL_UV === "0") return false;
	if (!stdin.isTTY || !stderr.isTTY) return false;

	const rl = createInterface({ input: stdin, output: stderr });
	try {
		const answer = (await rl.question("Prime Agent needs uv to set up Python. Install uv from astral.sh now? [Y/n] "))
			.trim()
			.toLowerCase();
		return answer !== "n" && answer !== "no";
	} finally {
		rl.close();
	}
}

async function readBootstrapVersion(venv: string): Promise<BootstrapVersion | null> {
	try {
		const raw = await readFile(path.join(venv, BOOTSTRAP_VERSION_FILE), "utf8");
		const parsed: unknown = JSON.parse(raw);
		if (!isRecord(parsed) || typeof parsed.schema !== "number") return null;
		const extraUvArgs =
			Array.isArray(parsed.extraUvArgs) &&
			parsed.extraUvArgs.every((v: unknown): v is string => typeof v === "string")
				? (parsed.extraUvArgs as string[])
				: undefined;
		let pythonSkills: BootstrapPythonSkill[] | undefined;
		if (Array.isArray(parsed.pythonSkills)) {
			if (
				!parsed.pythonSkills.every((v: unknown): v is BootstrapPythonSkill => {
					if (!isRecord(v)) return false;
					return (
						typeof v.importName === "string" &&
						typeof v.packagePath === "string" &&
						typeof v.pyprojectPath === "string" &&
						typeof v.pyprojectHash === "string"
					);
				})
			) {
				return null;
			}
			pythonSkills = parsed.pythonSkills as BootstrapPythonSkill[];
		}
		return {
			schema: parsed.schema,
			ipykernel: typeof parsed.ipykernel === "string" ? parsed.ipykernel : undefined,
			runtime: typeof parsed.runtime === "string" ? parsed.runtime : undefined,
			snapshot: typeof parsed.snapshot === "string" ? parsed.snapshot : undefined,
			extraUvArgs,
			pythonSkills,
		};
	} catch {
		return null;
	}
}

function extraUvArgsMatch(a: string[] | undefined, b: string[] | undefined): boolean {
	if (a === b) return true;
	if (!a || !b) return false;
	if (a.length !== b.length) return false;
	return a.every((v, i) => v === b[i]);
}

function pythonSkillsMatch(a: BootstrapPythonSkill[] | undefined, b: readonly BootstrapPythonSkill[]): boolean {
	const left = a ?? [];
	if (left.length !== b.length) return false;
	return left.every((skill, index) => {
		const expected = b[index];
		return (
			skill.importName === expected.importName &&
			skill.packagePath === expected.packagePath &&
			skill.pyprojectPath === expected.pyprojectPath &&
			skill.pyprojectHash === expected.pyprojectHash
		);
	});
}

function bootstrapVersionCurrent(
	version: BootstrapVersion | null,
	pythonSkills: readonly BootstrapPythonSkill[],
): boolean {
	return (
		version !== null && bootstrapBaseVersionCurrent(version) && pythonSkillsMatch(version.pythonSkills, pythonSkills)
	);
}

function bootstrapBaseVersionCurrent(version: BootstrapVersion | null): boolean {
	return (
		version?.schema === BOOTSTRAP_SCHEMA &&
		version.ipykernel === IPYKERNEL_REQUIREMENT &&
		version.runtime === RUNTIME_REQUIREMENT &&
		version.snapshot === STATE_SNAPSHOT_REQUIREMENT &&
		extraUvArgsMatch(version.extraUvArgs, DEFAULT_RLM_EXTRA_UV_ARGS)
	);
}

async function writeBootstrapVersion(venv: string, pythonSkills: readonly BootstrapPythonSkill[]): Promise<void> {
	const version: BootstrapVersion = {
		schema: BOOTSTRAP_SCHEMA,
		ipykernel: IPYKERNEL_REQUIREMENT,
		runtime: RUNTIME_REQUIREMENT,
		snapshot: STATE_SNAPSHOT_REQUIREMENT,
		extraUvArgs: DEFAULT_RLM_EXTRA_UV_ARGS,
		pythonSkills: [...pythonSkills],
	};
	await writeFile(path.join(venv, BOOTSTRAP_VERSION_FILE), `${JSON.stringify(version)}\n`, "utf8");
}

function runtimeCandidateDirs(): string[] {
	const moduleDir = path.dirname(fileURLToPath(import.meta.url));
	return [
		// Stable across layouts (dist/, dist/bundle/, tsx): <package>/dist/prime-agent-runtime
		path.join(getPackageDir(), "dist", "prime-agent-runtime"),
		path.resolve(moduleDir, "..", "..", "prime-agent-runtime"),
		path.resolve(moduleDir, "..", "..", "..", "..", "..", "prime-agent-runtime"),
	];
}

async function resolveRuntimeRequirement(): Promise<string> {
	for (const candidate of runtimeCandidateDirs()) {
		if (await exists(path.join(candidate, "pyproject.toml"))) {
			return candidate;
		}
	}
	return RUNTIME_REQUIREMENT;
}

async function bootstrapVenv(
	venv: string,
	pythonSkills: readonly BootstrapPythonSkill[],
	options: EnsureKernelPythonOptions,
): Promise<void> {
	await mkdir(path.dirname(venv), { recursive: true });
	const python = path.join(venv, "bin", "python");
	const runtimeRequirement = await resolveRuntimeRequirement();

	// Build the step list before running so the percentage denominator only
	// counts work that will actually happen on this machine.
	const needsUvInstall = (await locateUv()) === null;
	const steps: BootstrapStep[] = [
		...(needsUvInstall ? [BOOTSTRAP_STEP.uv] : []),
		BOOTSTRAP_STEP.python,
		BOOTSTRAP_STEP.venv,
		BOOTSTRAP_STEP.packages,
		...(pythonSkills.length > 0 ? [BOOTSTRAP_STEP.skills] : []),
	];
	const progress = new BootstrapProgress(options, steps);

	const uv = await ensureUv(options, needsUvInstall ? () => progress.begin(BOOTSTRAP_STEP.uv) : undefined);

	progress.begin(BOOTSTRAP_STEP.python);
	await run(uv, ["python", "install", PYTHON_VERSION]);

	progress.begin(BOOTSTRAP_STEP.venv);
	await run(uv, ["venv", venv, "--python", PYTHON_VERSION, "--seed"]);

	progress.begin(BOOTSTRAP_STEP.packages);
	await run(uv, [
		"pip",
		"install",
		"--python",
		python,
		IPYKERNEL_REQUIREMENT,
		runtimeRequirement,
		STATE_SNAPSHOT_REQUIREMENT,
		...DEFAULT_RLM_EXTRA_UV_ARGS,
	]);

	if (pythonSkills.length > 0) {
		progress.begin(BOOTSTRAP_STEP.skills);
	}
	await syncPythonSkills(uv, venv, python, pythonSkills, options);
}

async function syncPythonSkills(
	uv: string,
	venv: string,
	python: string,
	pythonSkills: readonly BootstrapPythonSkill[],
	options: EnsureKernelPythonOptions,
): Promise<void> {
	const version = await readBootstrapVersion(venv);
	const installedPythonSkills: BootstrapPythonSkill[] = [];
	const currentPythonSkills = new Map(
		(version?.pythonSkills ?? []).map((skill) => [`${skill.importName}\0${skill.packagePath}`, skill]),
	);

	for (const skill of pythonSkills) {
		const existingSkill = currentPythonSkills.get(`${skill.importName}\0${skill.packagePath}`);
		if (existingSkill?.pyprojectPath === skill.pyprojectPath && existingSkill.pyprojectHash === skill.pyprojectHash) {
			installedPythonSkills.push(skill);
			continue;
		}

		try {
			await run(uv, ["pip", "install", "--python", python, "--editable", skill.packagePath]);
			installedPythonSkills.push(skill);
		} catch (error) {
			reportProgress(
				options,
				`Warning: Python skill ${skill.importName} failed to install and will be unavailable: ${errorMessage(error)}`,
			);
		}
	}
	await writeBootstrapVersion(venv, installedPythonSkills);
}

async function kernelBaseReady(python: string, venv: string): Promise<boolean> {
	return (
		(await hasIpykernel(python)) &&
		(await hasPrimeAgentRuntime(python)) &&
		bootstrapBaseVersionCurrent(await readBootstrapVersion(venv))
	);
}

async function kernelReady(
	python: string,
	venv: string,
	pythonSkills: readonly BootstrapPythonSkill[],
): Promise<boolean> {
	return (
		(await hasIpykernel(python)) &&
		(await hasPrimeAgentRuntime(python)) &&
		bootstrapVersionCurrent(await readBootstrapVersion(venv), pythonSkills)
	);
}

function formatBootstrapFailure(error: unknown): Error {
	return new Error(
		`Failed to set up the Python kernel runtime. ${errorMessage(error)}\n` +
			"First-time setup needs internet to install uv, Python, ipykernel, prime-agent-runtime, and default Python packages; once set up, prime-agent runs offline. " +
			"Set PRIME_AGENT_KERNEL_PYTHON to a Python with ipykernel, a current prime-agent-runtime, and default Python packages installed to skip auto-bootstrap.",
	);
}

async function ensureKernelPythonUncached(
	options: EnsureKernelPythonOptions,
	pythonSkills: readonly BootstrapPythonSkill[],
): Promise<string> {
	const override = process.env.PRIME_AGENT_KERNEL_PYTHON;
	if (override) {
		const python = path.resolve(expandHome(override));
		const missing: string[] = [];
		if (!(await hasIpykernel(python))) missing.push("ipykernel");
		if (!(await hasPrimeAgentRuntime(python))) {
			missing.push(
				"a current prime-agent-runtime with callable rlm.run, rlm.host_request, and explicit harness CRUD methods",
			);
		}
		if (missing.length === 0) {
			const missingExtraImports = await missingRlmExtraImportLabels(python);
			if (missingExtraImports.length > 0) {
				missing.push(`default Python packages (${missingExtraImports.join(", ")})`);
			}
		}
		if (missing.length === 0 && pythonSkills.length > 0) {
			const missingPythonSkills = await missingPythonSkillImportLabels(python, options.pythonSkills ?? []);
			if (missingPythonSkills.length > 0) {
				reportProgress(
					options,
					`Warning: Python skills unavailable in PRIME_AGENT_KERNEL_PYTHON and will be disabled: ${missingPythonSkills.join(", ")}`,
				);
			}
		}
		if (missing.length === 0) return python;
		throw new Error(`PRIME_AGENT_KERNEL_PYTHON points to a Python missing ${missing.join(" and ")}: ${python}`);
	}

	const venv = await resolveWritableKernelVenvDir();
	const python = path.join(venv, "bin", "python");
	if (await kernelReady(python, venv, pythonSkills)) return python;

	const releaseLock = await acquireBootstrapLock(venv);
	try {
		if (await kernelReady(python, venv, pythonSkills)) return python;
		if (await kernelBaseReady(python, venv)) {
			await syncPythonSkills(await ensureUv(options), venv, python, pythonSkills, options);
			return python;
		}

		if (existsSync(venv)) {
			await rm(venv, { recursive: true, force: true });
		}

		await bootstrapVenv(venv, pythonSkills, options);
	} catch (error) {
		throw formatBootstrapFailure(error);
	} finally {
		await releaseLock().catch(() => undefined);
	}

	reportProgress(options, "✓ ready · 100%");
	return python;
}

export function ensureKernelPython(options: EnsureKernelPythonOptions = {}): Promise<string> {
	const pythonSkills = normalizePythonSkills(options.pythonSkills);
	const key = ensureKernelPythonKey(pythonSkills);
	if (inFlightEnsureKernelPython?.key === key) return inFlightEnsureKernelPython.promise;

	const promise = ensureKernelPythonUncached(options, pythonSkills).finally(() => {
		if (inFlightEnsureKernelPython?.promise === promise) inFlightEnsureKernelPython = null;
	});
	inFlightEnsureKernelPython = { key, promise };
	return promise;
}
