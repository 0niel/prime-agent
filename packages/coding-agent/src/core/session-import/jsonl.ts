import { createReadStream, statSync } from "node:fs";
import { createInterface } from "node:readline";

const MAX_IMPORT_FILE_BYTES = 256 * 1024 * 1024;

function validateImportFileSize(filePath: string): void {
	const size = statSync(filePath).size;
	if (size > MAX_IMPORT_FILE_BYTES) {
		throw new Error(`Session file exceeds the ${MAX_IMPORT_FILE_BYTES / 1024 / 1024} MB import limit`);
	}
}

export async function readJsonLinePrefix(filePath: string, limit: number): Promise<unknown[]> {
	validateImportFileSize(filePath);
	const values: unknown[] = [];
	const input = createReadStream(filePath, { encoding: "utf8" });
	const lines = createInterface({ input, crlfDelay: Infinity });
	try {
		for await (const line of lines) {
			if (!line.trim()) {
				continue;
			}
			try {
				values.push(JSON.parse(line) as unknown);
				if (values.length >= limit) {
					break;
				}
			} catch {}
		}
	} finally {
		lines.close();
		input.destroy();
	}
	return values;
}

export async function readJsonLines(
	filePath: string,
	onValue: (value: unknown) => void,
): Promise<{ malformedLines: number }> {
	validateImportFileSize(filePath);

	let malformedLines = 0;
	const input = createReadStream(filePath, { encoding: "utf8" });
	const lines = createInterface({ input, crlfDelay: Infinity });
	try {
		for await (const line of lines) {
			if (!line.trim()) {
				continue;
			}
			try {
				onValue(JSON.parse(line) as unknown);
			} catch {
				malformedLines++;
			}
		}
	} finally {
		lines.close();
		input.destroy();
	}
	return { malformedLines };
}
