import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getKernelVenvPythonPath, getUvInstallerLaunchSpec } from "../../../src/core/kernel/bootstrap.js";

describe("#660 Windows kernel bootstrap", () => {
	it("uses the Windows virtual-environment interpreter layout", () => {
		const venv = join("root", "kernel-venv");

		expect(getKernelVenvPythonPath(venv, "win32")).toBe(join(venv, "Scripts", "python.exe"));
		expect(getKernelVenvPythonPath(venv, "linux")).toBe(join(venv, "bin", "python"));
	});

	it("uses the native PowerShell uv installer on Windows", () => {
		const launch = getUvInstallerLaunchSpec("win32");

		expect(launch.command).toBe("powershell.exe");
		expect(launch.args).toEqual([
			"-NoLogo",
			"-NoProfile",
			"-NonInteractive",
			"-ExecutionPolicy",
			"Bypass",
			"-Command",
			"irm https://astral.sh/uv/install.ps1 | iex",
		]);
	});

	it("retains the shell installer on Unix", () => {
		expect(getUvInstallerLaunchSpec("darwin")).toEqual({
			command: "sh",
			args: ["-c", "curl -LsSf https://astral.sh/uv/install.sh | sh"],
			displayCommand: "curl -LsSf https://astral.sh/uv/install.sh | sh",
		});
	});
});
