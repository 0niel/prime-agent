import { setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { PrimeOnboardingSplashComponent } from "../src/modes/interactive/components/prime-onboarding-splash.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { PRIME_BUTTERFLY_LOGO } from "../src/themes/prime-logo.js";

describe("PrimeOnboardingSplashComponent", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	it("renders a left-aligned first-run onboarding action", () => {
		const component = new PrimeOnboardingSplashComponent(
			() => {},
			() => {},
			{ getRows: () => 36 },
		);
		const lines = component.render(100);
		const output = stripAnsi(lines.join("\n"));

		expect(lines).toHaveLength(36);
		expect(output).toContain("prime agent");
		expect(output).toContain("Press Enter to login with Prime Intellect");
		expect(output).toContain("Research and infrastructure assistant for high-context work.");
		expect(output).toContain("• Inspect logs, evals, training runs, and environments.");
		expect(output).toContain("• Keep context alive in Python state and artifacts.");
		expect(output).toContain("• Delegate focused work through recursive RLM calls.");
		expect(output).toContain("·");
		expect(output).not.toContain("long-context coding tasks");
		expect(output).not.toContain("Login with Prime Intellect");
		expect(output).not.toContain("████▀▀▀██▄");
		expect(output).not.toContain("Get Started");
		expect(output).not.toContain("One account for models, inference, and coding sessions.");
		expect(output).not.toContain("Choose your model and start building.");
		expect(output).not.toContain("╭───╮");
		expect(output).not.toContain("PRIME INTELLECT");
		expect(output).not.toContain("cancel");
		expect(output).not.toContain("A coding agent connected to Prime Intellect.");
		expect(output).not.toContain("Continue with Prime Intellect");
		expect(output).not.toContain("Use one account for managed inference, model access, and usage.");
		expect(output).not.toContain("/* BUILD */");
		expect(output).not.toContain("/* EVALUATE */");
		expect(output).not.toContain("/* TRAIN */");
		expect(output).not.toContain("/* DEPLOY */");
		expect(output).not.toContain("required for first-time setup");
		expect(output).not.toContain("Start with your Prime Intellect account.");
		expect(output).not.toContain("Log in with Prime Intellect");
		expect(output).not.toContain("→");
		expect(output).not.toContain("Use a subscription");
		expect(output).not.toContain("Use an API key");
		expect(output).toContain(PRIME_BUTTERFLY_LOGO.split("\n")[0].trim());
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(100);
		}
	});

	it("starts Prime login on confirm", () => {
		let selected = false;
		const component = new PrimeOnboardingSplashComponent(
			() => {
				selected = true;
			},
			() => {},
		);

		component.handleInput("\r");

		expect(selected).toBe(true);
	});

	it("renders a stable starfield", () => {
		const component = new PrimeOnboardingSplashComponent(
			() => {},
			() => {},
			{ getRows: () => 36 },
		);

		const firstRender = stripAnsi(component.render(100).join("\n"));
		const secondRender = stripAnsi(component.render(100).join("\n"));

		expect(secondRender).toBe(firstRender);
		expect(secondRender).toContain("prime agent");
		expect(secondRender).toContain("Press Enter to login with Prime Intellect");
	});

	it("centers stacked content in narrow terminals", () => {
		const component = new PrimeOnboardingSplashComponent(
			() => {},
			() => {},
			{ getRows: () => 40 },
		);
		const rendered = component.render(60).map((line) => stripAnsi(line));
		const titleLine = rendered.find((line) => line.includes("prime agent"));
		const hintLine = rendered.find((line) => line.includes("Press Enter to login with Prime Intellect"));

		expect(titleLine?.search(/\S/)).toBeGreaterThan(0);
		expect(hintLine?.search(/\S/)).toBeGreaterThan(0);
	});
});
