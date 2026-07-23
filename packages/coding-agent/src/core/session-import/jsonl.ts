import { createReadStream, statSync } from "node:fs";
import { createInterface } from "node:readline";

const MAX_IMPORT_FILE_BYTES = 256 * 1024 * 1024;

export async function readJsonLines(
	filePath: string,
	onValue: (value: unknown) => void,
): Promise<{ malformedLines: number }> {
	const size = statSync(filePath).size;
	if (size > MAX_IMPORT_FILE_BYTES) {
		throw new Error(`Session file exceeds the ${MAX_IMPORT_FILE_BYTES / 1024 / 1024} MB import limit`);
	}

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
