/**
 * Tools Configuration
 *
 * Use tool names to choose which built-in tools are enabled.
 *
 * Tool names are matched against all available tools. If you use a custom `cwd`,
 * createAgentSession() applies that cwd when it builds the actual built-in tools.
 *
 * For custom tools, see 06-extensions.ts - custom tools are registered via the
 * extensions system using pi.registerTool().
 */

import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";

// Default tool surface
await createAgentSession({
	tools: ["ipython"],
	sessionManager: SessionManager.inMemory(),
});
console.log("IPython session created");

// Custom tool selection
await createAgentSession({
	tools: ["ipython", "bash"],
	sessionManager: SessionManager.inMemory(),
});
console.log("Custom tools session created");

// With custom cwd
const customCwd = "/path/to/project";
await createAgentSession({
	cwd: customCwd,
	tools: ["ipython", "bash", "edit"],
	sessionManager: SessionManager.inMemory(customCwd),
});
console.log("Custom cwd session created");

// Or pick specific tools for custom cwd
await createAgentSession({
	cwd: customCwd,
	tools: ["bash", "edit"],
	sessionManager: SessionManager.inMemory(customCwd),
});
console.log("Specific tools with custom cwd session created");
