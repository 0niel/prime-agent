import { randomUUID } from "node:crypto";
import {
	closeSync,
	fchmodSync,
	fchownSync,
	fsyncSync,
	openSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

export interface AtomicReplaceOptions {
	mode?: number;
	preserveExistingMetadata?: boolean;
}

interface FileMetadata {
	mode: number;
	uid: number;
	gid: number;
}

function realpathIfPresent(path: string): string {
	try {
		return realpathSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return path;
		throw error;
	}
}

function metadataIfPresent(path: string): FileMetadata | undefined {
	try {
		const { mode, uid, gid } = statSync(path);
		return { mode: mode & 0o777, uid, gid };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

function syncDirectory(path: string): void {
	if (process.platform === "win32") return;
	const fd = openSync(path, "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

export function replaceFileAtomicallySync(
	path: string,
	write: (fd: number, currentPath: string) => void,
	options: AtomicReplaceOptions = {},
): void {
	const targetPath = realpathIfPresent(path);
	const directory = dirname(targetPath);
	const metadata = options.preserveExistingMetadata === false ? undefined : metadataIfPresent(targetPath);
	const mode = options.mode ?? metadata?.mode ?? 0o666;
	const tempPath = join(directory, `.${basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`);
	let fd: number | undefined = openSync(tempPath, "wx", mode);
	try {
		write(fd, targetPath);
		if (metadata !== undefined && process.platform !== "win32") {
			fchownSync(fd, metadata.uid, metadata.gid);
		}
		fchmodSync(fd, mode);
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		renameSync(tempPath, targetPath);
		syncDirectory(directory);
	} finally {
		if (fd !== undefined) {
			closeSync(fd);
		}
		rmSync(tempPath, { force: true });
	}
}

export function writeFileAtomicallySync(
	path: string,
	data: string | NodeJS.ArrayBufferView,
	options: AtomicReplaceOptions = {},
): void {
	replaceFileAtomicallySync(path, (fd) => writeFileSync(fd, data), options);
}
