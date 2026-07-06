import assert from "node:assert";
import { describe, it } from "node:test";
import { type Component, TUI } from "../src/tui.js";
import { VirtualTerminal } from "./virtual-terminal.js";

class TestComponent implements Component {
	lines: string[] = [];
	render(_width: number): string[] {
		return this.lines;
	}
	invalidate(): void {}
}

class LoggingVirtualTerminal extends VirtualTerminal {
	private writes: string[] = [];

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}

	getWrites(): string {
		return this.writes.join("");
	}

	clearWrites(): void {
		this.writes = [];
	}
}

const WHEEL_UP = "\x1b[<64;5;5M";
const WHEEL_DOWN = "\x1b[<65;5;5M";
const PAGE_UP = "\x1b[5~";
const VIEWPORT_TOP = "\x1b[1;4A"; // shift+alt+up
const FOLLOW = "\x1b[1;3B"; // alt+down

interface Setup {
	terminal: LoggingVirtualTerminal;
	tui: TUI;
	chat: TestComponent;
	dock: TestComponent;
}

function setup(transcriptLines: string[], cols = 40, rows = 10): Setup {
	const terminal = new LoggingVirtualTerminal(cols, rows);
	const tui = new TUI(terminal);
	const chat = new TestComponent();
	chat.lines = transcriptLines;
	const dock = new TestComponent();
	dock.lines = ["> prompt", "footer"];
	// Children drive inline rendering (before enter / after exit); the same
	// components are passed explicitly as fullscreen scroll/dock roots.
	tui.addChild(chat);
	tui.addChild(dock);
	tui.start();
	return { terminal, tui, chat, dock };
}

function lines(count: number, prefix = "Line"): string[] {
	return Array.from({ length: count }, (_, i) => `${prefix} ${i}`);
}

describe("TUI fullscreen mode", () => {
	it("enters the alt screen and lays out transcript window above the dock", async () => {
		const { terminal, tui, chat, dock } = setup(lines(20));
		await terminal.waitForRender();

		tui.enterFullscreen({ scroll: [chat], dock });
		await terminal.waitForRender();

		assert.strictEqual(tui.isFullscreen(), true);
		assert.strictEqual(terminal.getActiveBufferType(), "alternate");
		assert.strictEqual(terminal.mouseTrackingActive, true, "probe succeeds → wheel tracking enabled");

		// rows=10, dock=2 → window shows the last 8 of 20 transcript lines
		const viewport = terminal.getViewport();
		assert.strictEqual(viewport[0], "Line 12");
		assert.strictEqual(viewport[7], "Line 19");
		assert.strictEqual(viewport[8], "> prompt");
		assert.strictEqual(viewport[9], "footer");

		tui.stop();
	});

	it("keeps the window pinned to the bottom while following", async () => {
		const { terminal, tui, chat, dock } = setup(lines(20));
		tui.enterFullscreen({ scroll: [chat], dock });
		await terminal.waitForRender();

		chat.lines = lines(25);
		tui.requestRender();
		await terminal.waitForRender();

		const viewport = terminal.getViewport();
		assert.strictEqual(viewport[7], "Line 24", "window follows appended content");
		assert.strictEqual(viewport[8], "> prompt", "dock stays pinned");

		tui.stop();
	});

	it("wheel up unfollows and freezes the window while content appends", async () => {
		const { terminal, tui, chat, dock } = setup(lines(20));
		tui.enterFullscreen({ scroll: [chat], dock });
		await terminal.waitForRender();

		terminal.sendInput(WHEEL_UP);
		await terminal.waitForRender();

		let viewport = terminal.getViewport();
		assert.strictEqual(viewport[0], "Line 9", "wheel scrolls up 3 lines");
		assert.strictEqual(tui.getScrollInfo()?.following, false);

		chat.lines = lines(40);
		tui.requestRender();
		await terminal.waitForRender();

		viewport = terminal.getViewport();
		assert.strictEqual(viewport[0], "Line 9", "appended content does not move the window");
		assert.strictEqual(viewport[8], "> prompt", "dock still visible");
		assert.strictEqual(tui.getScrollInfo()?.linesBelow, 23);
		assert.ok(viewport[7]?.includes("to follow"), "follow hint composited above the dock");

		tui.stop();
	});

	it("hides the follow hint while following", async () => {
		const { terminal, tui, chat, dock } = setup(lines(20));
		tui.enterFullscreen({ scroll: [chat], dock });
		await terminal.waitForRender();

		assert.ok(!terminal.getViewport().join("\n").includes("to follow"));

		terminal.sendInput(WHEEL_UP);
		await terminal.waitForRender();
		assert.ok(terminal.getViewport().join("\n").includes("to follow"));

		terminal.sendInput(FOLLOW);
		await terminal.waitForRender();
		assert.ok(!terminal.getViewport().join("\n").includes("to follow"));

		tui.stop();
	});

	it("scrolling back to the bottom resumes following", async () => {
		const { terminal, tui, chat, dock } = setup(lines(20));
		tui.enterFullscreen({ scroll: [chat], dock });
		await terminal.waitForRender();

		terminal.sendInput(WHEEL_UP);
		await terminal.waitForRender();
		assert.strictEqual(tui.getScrollInfo()?.following, false);

		terminal.sendInput(WHEEL_DOWN);
		await terminal.waitForRender();
		assert.strictEqual(tui.getScrollInfo()?.following, true);

		chat.lines = lines(22);
		tui.requestRender();
		await terminal.waitForRender();
		assert.strictEqual(terminal.getViewport()[7], "Line 21");

		tui.stop();
	});

	it("page and home/end keys scroll the window while the editor keeps focus", async () => {
		const { terminal, tui, chat, dock } = setup(lines(30));
		const editor = new TestComponent();
		tui.setFocus(editor);
		tui.enterFullscreen({ scroll: [chat], dock });
		await terminal.waitForRender();

		terminal.sendInput(PAGE_UP);
		await terminal.waitForRender();
		// window height 8 → page size 7; top was 22, now 15
		assert.strictEqual(terminal.getViewport()[0], "Line 15");

		terminal.sendInput(VIEWPORT_TOP);
		await terminal.waitForRender();
		assert.strictEqual(terminal.getViewport()[0], "Line 0");
		assert.strictEqual(tui.getScrollInfo()?.following, false);

		terminal.sendInput(FOLLOW);
		await terminal.waitForRender();
		assert.strictEqual(terminal.getViewport()[7], "Line 29");
		assert.strictEqual(tui.getScrollInfo()?.following, true);

		tui.stop();
	});

	it("row-diffs frames: only changed rows are repainted", async () => {
		const { terminal, tui, chat, dock } = setup(lines(20));
		tui.enterFullscreen({ scroll: [chat], dock });
		await terminal.waitForRender();
		terminal.clearWrites();

		chat.lines = [...lines(19), "Line 19 changed"];
		tui.requestRender();
		await terminal.waitForRender();

		const writes = terminal.getWrites();
		assert.ok(!writes.includes("\x1b[2J"), "no full clear for a single-line change");
		assert.ok(writes.includes("\x1b[8;1H"), "repaints the changed row (window row 8)");
		const repaintedRows = writes.match(/\x1b\[\d+;1H\x1b\[2K/g) ?? [];
		assert.strictEqual(repaintedRows.length, 1, "exactly one row repainted");
		assert.strictEqual(terminal.getViewport()[7], "Line 19 changed");

		tui.stop();
	});

	it("resize repaints the whole frame and clamps the scroll position", async () => {
		const { terminal, tui, chat, dock } = setup(lines(30));
		tui.enterFullscreen({ scroll: [chat], dock });
		await terminal.waitForRender();

		terminal.sendInput(VIEWPORT_TOP);
		await terminal.waitForRender();
		terminal.clearWrites();

		terminal.resize(40, 20);
		await terminal.waitForRender();

		assert.ok(terminal.getWrites().includes("\x1b[2J"), "resize forces a full frame repaint");
		const viewport = terminal.getViewport();
		assert.strictEqual(viewport[0], "Line 0", "scroll position clamped, still at top");
		assert.strictEqual(viewport[18], "> prompt", "dock re-anchored to the new bottom");

		tui.stop();
	});

	it("composites overlays onto the fullscreen frame", async () => {
		const { terminal, tui, chat, dock } = setup(lines(20));
		tui.enterFullscreen({ scroll: [chat], dock });
		await terminal.waitForRender();

		const overlay = new TestComponent();
		overlay.lines = ["OVERLAY CONTENT"];
		const handle = tui.showOverlay(overlay, { anchor: "center", width: 20 });
		await terminal.waitForRender();

		assert.ok(
			terminal.getViewport().some((line) => line.includes("OVERLAY CONTENT")),
			"overlay visible on the fullscreen frame",
		);

		handle.hide();
		await terminal.waitForRender();
		assert.ok(!terminal.getViewport().some((line) => line.includes("OVERLAY CONTENT")));

		tui.stop();
	});

	it("exit restores the primary screen and flushes fullscreen-era content into scrollback", async () => {
		const { terminal, tui, chat, dock } = setup(lines(5));
		await terminal.waitForRender();

		tui.enterFullscreen({ scroll: [chat], dock });
		await terminal.waitForRender();
		assert.strictEqual(terminal.getActiveBufferType(), "alternate");

		chat.lines = lines(30);
		tui.requestRender();
		await terminal.waitForRender();

		tui.exitFullscreen();
		await terminal.waitForRender();

		assert.strictEqual(tui.isFullscreen(), false);
		assert.strictEqual(terminal.getActiveBufferType(), "normal");
		assert.strictEqual(terminal.mouseTrackingActive, false);
		const scrollBuffer = terminal.getScrollBuffer().join("\n");
		assert.ok(scrollBuffer.includes("Line 29"), "content appended while fullscreen reached the primary buffer");
		assert.ok(scrollBuffer.includes("Line 0"), "pre-fullscreen content still present");

		tui.stop();
	});

	it("stop() leaves the alt screen and disables mouse tracking", async () => {
		const { terminal, tui, chat, dock } = setup(lines(20));
		tui.enterFullscreen({ scroll: [chat], dock });
		await terminal.waitForRender();

		tui.stop();
		await terminal.flush();

		assert.strictEqual(terminal.getActiveBufferType(), "normal");
		assert.strictEqual(terminal.mouseTrackingActive, false);
	});

	it("drag-selecting copies the selected text on release", async () => {
		const { terminal, tui, chat, dock } = setup(lines(20));
		const copies: string[] = [];
		tui.onCopy = (text) => copies.push(text);
		tui.enterFullscreen({ scroll: [chat], dock });
		await terminal.waitForRender();

		// window shows lines 12-19; press on row 1 col 1, drag to row 2 col 6
		terminal.sendInput("\x1b[<0;1;1M");
		terminal.sendInput("\x1b[<32;6;2M");
		await terminal.waitForRender();
		assert.ok(terminal.getWrites().includes("\x1b[7m"), "selection highlighted while dragging");

		terminal.sendInput("\x1b[<0;6;2m");
		await terminal.waitForRender();
		assert.deepStrictEqual(copies, ["Line 12\nLine"]);

		tui.stop();
	});

	it("writes OSC 52 when no copy handler is set", async () => {
		const { terminal, tui, chat, dock } = setup(lines(20));
		tui.enterFullscreen({ scroll: [chat], dock });
		await terminal.waitForRender();
		terminal.clearWrites();

		terminal.sendInput("\x1b[<0;1;1M");
		terminal.sendInput("\x1b[<32;8;1M");
		terminal.sendInput("\x1b[<0;8;1m");
		await terminal.waitForRender();

		const expected = Buffer.from("Line 12", "utf8").toString("base64");
		assert.ok(terminal.getWrites().includes(`\x1b]52;c;${expected}\x07`));

		tui.stop();
	});

	it("a plain click copies nothing and clears any selection", async () => {
		const { terminal, tui, chat, dock } = setup(lines(20));
		const copies: string[] = [];
		tui.onCopy = (text) => copies.push(text);
		tui.enterFullscreen({ scroll: [chat], dock });
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;5;3M");
		terminal.sendInput("\x1b[<0;5;3m");
		await terminal.waitForRender();

		assert.deepStrictEqual(copies, []);

		tui.stop();
	});

	it("mouse reports are consumed and never reach the focused component", async () => {
		const { terminal, tui, chat, dock } = setup(lines(20));
		const received: string[] = [];
		const editor: Component = {
			render: () => [],
			invalidate: () => {},
			handleInput: (data: string) => received.push(data),
		};
		tui.setFocus(editor);
		tui.enterFullscreen({ scroll: [chat], dock });
		await terminal.waitForRender();

		terminal.sendInput(WHEEL_UP);
		terminal.sendInput("\x1b[<0;3;3M"); // left click
		terminal.sendInput("a");
		await terminal.waitForRender();

		assert.deepStrictEqual(received, ["a"], "only keyboard input reaches the editor");

		tui.stop();
	});
});
