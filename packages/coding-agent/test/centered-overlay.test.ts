import { type Component, type Focusable, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { CenteredOverlayComponent } from "../src/modes/interactive/components/centered-overlay.js";

class TestComponent implements Component, Focusable {
	focused = false;
	readonly inputs: string[] = [];

	invalidate(): void {
		// Test component has no cached render state.
	}

	render(width: number): string[] {
		return [`content ${width}`, "second row"];
	}

	handleInput(data: string): void {
		this.inputs.push(data);
	}
}

describe("CenteredOverlayComponent", () => {
	it("centers content and fills the full pane width and height", () => {
		const component = new CenteredOverlayComponent(new TestComponent(), {
			getRows: () => 6,
			maxContentWidth: 12,
		});

		const lines = component.render(20);

		expect(lines).toHaveLength(6);
		expect(lines[0]?.trim()).toBe("");
		expect(lines[1]?.trim()).toBe("");
		expect(lines[2]).toContain("content 12");
		expect(lines[3]).toContain("second row");
		expect(lines[4]?.trim()).toBe("");
		expect(lines[5]?.trim()).toBe("");
		for (const line of lines) {
			expect(visibleWidth(line)).toBe(20);
		}
	});

	it("forwards focus and input to the wrapped component", () => {
		const inner = new TestComponent();
		const component = new CenteredOverlayComponent(inner, {
			getRows: () => 1,
		});

		component.focused = true;
		component.handleInput("x");

		expect(inner.focused).toBe(true);
		expect(inner.inputs).toEqual(["x"]);
	});
});
