import { existsSync, writeFileSync } from "node:fs";
import {
	SessionManager,
	setSessionLockReleaseHookForTest,
	setSessionLockTransitionHookForTest,
	setSessionTailInspectionHookForTest,
} from "../../../src/core/session-manager.js";

const [sessionPath, name, startedPath, donePath, readyPath, goPath, openedPath, appendGoPath, attemptPath] =
	process.argv.slice(2);
if (!sessionPath || !name || !startedPath || !donePath) throw new Error("Missing session tail writer arguments");
const wait = new Int32Array(new SharedArrayBuffer(4));

if (readyPath && goPath) {
	const pause = () => {
		writeFileSync(readyPath, "ready");
		while (!existsSync(goPath)) Atomics.wait(wait, 0, 0, 10);
	};
	if (process.env.SESSION_LOCK_CRASH_PHASE === "transition") setSessionLockTransitionHookForTest(pause);
	else if (process.env.SESSION_LOCK_CRASH_PHASE !== "release") setSessionTailInspectionHookForTest(pause);
}

writeFileSync(startedPath, "started");
const manager = SessionManager.open(sessionPath);
if (process.env.SESSION_LOCK_CRASH_PHASE === "release" && readyPath && goPath) {
	setSessionLockReleaseHookForTest(() => {
		writeFileSync(readyPath, "ready");
		while (!existsSync(goPath)) Atomics.wait(wait, 0, 0, 10);
	});
}
if (openedPath && appendGoPath) {
	writeFileSync(openedPath, "opened");
	while (!existsSync(appendGoPath)) Atomics.wait(wait, 0, 0, 10);
}
if (attemptPath) writeFileSync(attemptPath, "attempt");
manager.appendSessionInfo(name);
writeFileSync(donePath, JSON.stringify(manager.getFileRecovery() ?? null));
