import { randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	constants,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const NOFOLLOW_FLAG = constants.O_NOFOLLOW ?? 0;

export function assertRegularFileNoSymlink(path: string): void {
	const stats = lstatSync(path);
	if (stats.isSymbolicLink() || !stats.isFile()) {
		throw new Error(`Refusing to use non-regular private file: ${path}`);
	}
}

export function ensurePrivateDirectory(path: string): void {
	mkdirSync(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
	const stats = lstatSync(path);
	if (stats.isSymbolicLink() || !stats.isDirectory()) {
		throw new Error(`Refusing to use non-directory private path: ${path}`);
	}
	chmodSync(path, PRIVATE_DIRECTORY_MODE);
}

export function ensurePrivateFile(path: string, initialContent = ""): void {
	ensurePrivateDirectory(dirname(path));
	if (!existsSync(path)) {
		let fd: number | undefined;
		try {
			fd = openSync(
				path,
				constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW_FLAG,
				PRIVATE_FILE_MODE,
			);
			writeFileSync(fd, initialContent);
		} finally {
			if (fd !== undefined) closeSync(fd);
		}
	}
	assertRegularFileNoSymlink(path);
	chmodSync(path, PRIVATE_FILE_MODE);
}

export function readPrivateFile(path: string, encoding: BufferEncoding): string {
	assertRegularFileNoSymlink(path);
	chmodSync(path, PRIVATE_FILE_MODE);
	const fd = openSync(path, constants.O_RDONLY | NOFOLLOW_FLAG);
	try {
		return readFileSync(fd, encoding);
	} finally {
		closeSync(fd);
	}
}

export function writePrivateFileAtomic(path: string, content: string | Uint8Array): void {
	ensurePrivateDirectory(dirname(path));
	if (existsSync(path)) {
		assertRegularFileNoSymlink(path);
	}
	const tempPath = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
	let fd: number | undefined;
	try {
		fd = openSync(
			tempPath,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW_FLAG,
			PRIVATE_FILE_MODE,
		);
		writeFileSync(fd, content);
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		renameSync(tempPath, path);
		chmodSync(path, PRIVATE_FILE_MODE);
	} finally {
		if (fd !== undefined) closeSync(fd);
		rmSync(tempPath, { force: true });
	}
}

export function appendPrivateFile(path: string, content: string): void {
	ensurePrivateDirectory(dirname(path));
	let flags = constants.O_WRONLY | constants.O_APPEND | NOFOLLOW_FLAG;
	if (existsSync(path)) {
		assertRegularFileNoSymlink(path);
		chmodSync(path, PRIVATE_FILE_MODE);
	} else {
		flags |= constants.O_CREAT | constants.O_EXCL;
	}
	const fd = openSync(path, flags, PRIVATE_FILE_MODE);
	try {
		writeFileSync(fd, content);
	} finally {
		closeSync(fd);
	}
}
