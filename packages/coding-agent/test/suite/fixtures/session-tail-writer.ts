import { existsSync, writeFileSync } from "node:fs";
import { SessionManager, setSessionTailInspectionHookForTest } from "../../../src/core/session-manager.js";

const [sessionPath, name, startedPath, donePath, readyPath, goPath, openedPath, appendGoPath, attemptPath] =
	process.argv.slice(2);
if (!sessionPath || !name || !startedPath || !donePath) throw new Error("Missing session tail writer arguments");
const wait = new Int32Array(new SharedArrayBuffer(4));

if (readyPath && goPath) {
	setSessionTailInspectionHookForTest(() => {
		writeFileSync(readyPath, "ready");
		while (!existsSync(goPath)) Atomics.wait(wait, 0, 0, 10);
	});
}

writeFileSync(startedPath, "started");
const manager = SessionManager.open(sessionPath);
if (openedPath && appendGoPath) {
	writeFileSync(openedPath, "opened");
	while (!existsSync(appendGoPath)) Atomics.wait(wait, 0, 0, 10);
}
if (attemptPath) writeFileSync(attemptPath, "attempt");
manager.appendSessionInfo(name);
writeFileSync(donePath, JSON.stringify(manager.getFileRecovery() ?? null));
