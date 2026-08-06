import { describe, expect, it } from "vitest";
import { resolveHeadlessDaemonSessionLifecycle, shouldUseResidentAcpSession } from "../src/main.js";

describe("ACP daemon lifecycle negotiation", () => {
	it("uses resident sessions only when the daemon advertises the capability", () => {
		expect(shouldUseResidentAcpSession(["acp_resident_sessions"])).toBe(true);
		expect(shouldUseResidentAcpSession(["client_owned_sessions"])).toBe(false);
		expect(shouldUseResidentAcpSession([])).toBe(false);
		expect(resolveHeadlessDaemonSessionLifecycle({ preferResident: true, serverCapabilities: ["acp_resident_sessions"] })).toBe("resident");
		expect(resolveHeadlessDaemonSessionLifecycle({ preferResident: true, serverCapabilities: [] })).toBe("client_owned");
		expect(resolveHeadlessDaemonSessionLifecycle({ clientOwned: true, serverCapabilities: ["acp_resident_sessions"] })).toBe("client_owned");
	});
});
