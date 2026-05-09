import { ensureKernelPython } from "./core/kernel/bootstrap.js";

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function oneLine(message: string): string {
	return message.replace(/\s+/g, " ").trim();
}

try {
	await ensureKernelPython();
} catch (error) {
	console.error(`prime-agent: python kernel setup skipped: ${oneLine(errorMessage(error))}`);
}
