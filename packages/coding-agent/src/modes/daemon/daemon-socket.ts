import { chmodSync, existsSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";

const DAEMON_SOCKET_MODE = 0o600;
const DAEMON_SOCKET_DIR_MODE = 0o700;
const DAEMON_SOCKET_RELEASE_GRACE_MS = 1000;
const DAEMON_SOCKET_RELEASE_POLL_MS = 25;
const DAEMON_SOCKET_LOCK_STALE_MS = 5000;
const DAEMON_SOCKET_LOCK_UPDATE_MS = 1000;

export interface DaemonSocketIdentity {
	dev: number;
	ino: number;
}

export function defaultDaemonSocketPath(): string {
	if (process.platform === "win32") {
		return "\\\\.\\pipe\\prime-agent-daemon";
	}
	return join(defaultDaemonSocketDir(), "daemon.sock");
}

export async function prepareDaemonSocketPath(socketPath: string): Promise<void> {
	ensureDefaultDaemonSocketDir(socketPath);

	if (process.platform === "win32") {
		return;
	}
	if (!existsSync(socketPath)) {
		return;
	}
	if (await canConnectToUnixSocket(socketPath)) {
		throw new Error(`Daemon socket already in use: ${socketPath}`);
	}
	const releaseLock = await lockfile.lock(socketPath, {
		realpath: false,
		stale: DAEMON_SOCKET_LOCK_STALE_MS,
		update: DAEMON_SOCKET_LOCK_UPDATE_MS,
		retries: {
			retries: 600,
			factor: 1,
			minTimeout: DAEMON_SOCKET_RELEASE_POLL_MS,
			maxTimeout: DAEMON_SOCKET_RELEASE_POLL_MS,
		},
	});
	try {
		await prepareUnixDaemonSocketPath(socketPath);
	} finally {
		await releaseLock();
	}
}

async function prepareUnixDaemonSocketPath(socketPath: string): Promise<void> {
	if (!existsSync(socketPath)) {
		return;
	}

	let stat: ReturnType<typeof lstatSync>;
	try {
		stat = lstatSync(socketPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return;
		}
		throw error;
	}
	if (!stat.isSocket()) {
		throw new Error(`Daemon socket path exists and is not a socket: ${socketPath}`);
	}

	const staleIdentity: DaemonSocketIdentity = { dev: stat.dev, ino: stat.ino };
	if (await canConnectToUnixSocket(socketPath)) {
		throw new Error(`Daemon socket already in use: ${socketPath}`);
	}
	const deadline = Date.now() + DAEMON_SOCKET_RELEASE_GRACE_MS;
	while (Date.now() < deadline) {
		await delay(DAEMON_SOCKET_RELEASE_POLL_MS);
		if (!existsSync(socketPath)) {
			return;
		}
		let currentIdentity: DaemonSocketIdentity | undefined;
		try {
			currentIdentity = getDaemonSocketIdentity(socketPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return;
			}
			throw error;
		}
		if (!currentIdentity || currentIdentity.dev !== staleIdentity.dev || currentIdentity.ino !== staleIdentity.ino) {
			throw new Error(`Daemon socket changed ownership while waiting for cleanup: ${socketPath}`);
		}
		if (await canConnectToUnixSocket(socketPath)) {
			throw new Error(`Daemon socket already in use: ${socketPath}`);
		}
	}

	unlinkSync(socketPath);
}

export function restrictDaemonSocketPath(socketPath: string): void {
	if (process.platform === "win32") {
		return;
	}
	chmodSync(socketPath, DAEMON_SOCKET_MODE);
}

export function getDaemonSocketIdentity(socketPath: string): DaemonSocketIdentity | undefined {
	if (process.platform === "win32") {
		return undefined;
	}
	const stat = lstatSync(socketPath);
	return { dev: stat.dev, ino: stat.ino };
}

export function cleanupDaemonSocketPath(socketPath: string, expectedIdentity?: DaemonSocketIdentity): void {
	if (process.platform === "win32") {
		return;
	}
	let releaseLock: (() => void) | undefined;
	try {
		releaseLock = lockfile.lockSync(socketPath, {
			realpath: false,
			stale: DAEMON_SOCKET_LOCK_STALE_MS,
			update: DAEMON_SOCKET_LOCK_UPDATE_MS,
			retries: 0,
		});
	} catch {
		return;
	}
	try {
		if (!existsSync(socketPath)) {
			return;
		}
		if (expectedIdentity) {
			const currentIdentity = getDaemonSocketIdentity(socketPath);
			if (
				!currentIdentity ||
				currentIdentity.dev !== expectedIdentity.dev ||
				currentIdentity.ino !== expectedIdentity.ino
			) {
				return;
			}
		}
		unlinkSync(socketPath);
	} catch {
		// Best effort cleanup; shutdown should not be blocked by socket unlink failures.
	} finally {
		try {
			releaseLock();
		} catch {
			// Best effort cleanup; a failed release is recoverable as a stale lock.
		}
	}
}

export function defaultDaemonSocketDir(): string {
	const suffix = typeof process.getuid === "function" ? String(process.getuid()) : "user";
	return join(tmpdir(), `prime-agent-${suffix}`);
}

function ensureDefaultDaemonSocketDir(socketPath: string): void {
	if (process.platform === "win32" || dirname(socketPath) !== defaultDaemonSocketDir()) {
		return;
	}

	if (!existsSync(defaultDaemonSocketDir())) {
		mkdirSync(defaultDaemonSocketDir(), { recursive: true, mode: DAEMON_SOCKET_DIR_MODE });
	}

	const stat = lstatSync(defaultDaemonSocketDir());
	if (!stat.isDirectory()) {
		throw new Error(`Daemon socket directory exists and is not a directory: ${defaultDaemonSocketDir()}`);
	}

	if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
		throw new Error(`Daemon socket directory is not owned by the current user: ${defaultDaemonSocketDir()}`);
	}

	chmodSync(defaultDaemonSocketDir(), DAEMON_SOCKET_DIR_MODE);
}

function canConnectToUnixSocket(socketPath: string): Promise<boolean> {
	return new Promise((resolveConnect) => {
		const socket = createConnection(socketPath);
		let settled = false;
		let timeoutId: ReturnType<typeof setTimeout> | undefined;

		const finish = (canConnect: boolean) => {
			if (settled) {
				return;
			}
			settled = true;
			if (timeoutId) {
				clearTimeout(timeoutId);
			}
			socket.removeAllListeners();
			socket.destroy();
			resolveConnect(canConnect);
		};

		timeoutId = setTimeout(() => finish(false), 250);
		socket.once("connect", () => finish(true));
		socket.once("error", () => finish(false));
	});
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
