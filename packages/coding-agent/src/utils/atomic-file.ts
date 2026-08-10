import { randomUUID } from "node:crypto";
import {
	closeSync,
	fchmodSync,
	fchownSync,
	fsyncSync,
	lstatSync,
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
	createMode?: number;
	preserveExistingMetadata?: boolean;
}

interface FileMetadata {
	mode: number;
	uid: number;
	gid: number;
}

export function resolveManagedFilePathSync(path: string, label: string): string {
	try {
		const stats = lstatSync(path);
		if (stats.isSymbolicLink()) throw new Error(`Refusing ${label} symlink: non-regular private file: ${path}`);
		if (!stats.isFile()) throw new Error(`Refusing non-file ${label} path: non-regular private file: ${path}`);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	return join(realpathSync(dirname(path)), basename(path));
}

export function resolveFileTargetSync(path: string): string {
	try {
		return realpathSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		try {
			if (lstatSync(path).isSymbolicLink()) {
				throw new Error(`Refusing to replace dangling symlink: ${path}`);
			}
		} catch (lstatError) {
			if ((lstatError as NodeJS.ErrnoException).code !== "ENOENT") throw lstatError;
		}
		const directory = realpathSync(dirname(path));
		return join(directory, basename(path));
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
	const targetPath = resolveFileTargetSync(path);
	const directory = dirname(targetPath);
	const metadata = options.preserveExistingMetadata === false ? undefined : metadataIfPresent(targetPath);
	const mode = options.mode ?? metadata?.mode ?? (metadata === undefined ? options.createMode : undefined);
	const tempPath = join(directory, `.${basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`);
	let fd: number | undefined = openSync(tempPath, "wx", mode ?? 0o666);
	try {
		write(fd, targetPath);
		if (metadata !== undefined && process.platform !== "win32") {
			fchownSync(fd, metadata.uid, metadata.gid);
		}
		if (mode !== undefined) {
			fchmodSync(fd, mode);
		}
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		renameSync(tempPath, targetPath);
		syncDirectory(directory);
	} finally {
		try {
			if (fd !== undefined) closeSync(fd);
		} finally {
			rmSync(tempPath, { force: true });
		}
	}
}

export function writeFileAtomicallySync(
	path: string,
	data: string | NodeJS.ArrayBufferView,
	options: AtomicReplaceOptions = {},
): void {
	replaceFileAtomicallySync(path, (fd) => writeFileSync(fd, data), options);
}
