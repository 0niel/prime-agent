import { ensureKernelPython } from "./core/kernel/bootstrap.js";

if (process.env.PRIME_AGENT_BOOTSTRAP_KERNEL_ON_INSTALL !== "1") {
	process.exit(0);
}

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
