import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const installerSource = readFileSync("install.sh", "utf-8");
const mainCall = '\nmain "$@"';
const mainCallIndex = installerSource.lastIndexOf(mainCall);
const ansiPattern = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const failures = [];

if (mainCallIndex === -1) {
	console.error('Installer render check failed: could not find final main "$@" call.');
	process.exit(1);
}

const harnessSource = `${installerSource.slice(0, mainCallIndex)}

print_render_meta() {
	label="$1"
	if prime_agent_show_logo; then
		visible=1
	else
		visible=0
	fi
	content_height=$(prime_agent_content_height)
	printf '__META__ %s cols=%s rows=%s layout_show_logo=%s lab_width=%s render_lab_width=%s compact=%s visible=%s content_height=%s\\n' \\
		"$label" "$prime_agent_screen_cols" "$prime_agent_screen_rows" "$prime_agent_screen_layout_show_logo" \\
		"$prime_agent_screen_layout_lab_width" "$prime_agent_screen_render_lab_width" "$prime_agent_screen_compact" "$visible" "$content_height"
}

render_case() {
	prime_agent_screen_title="Installing Prime Agent"
	prime_agent_screen_detail="Fetching the verified package."
	prime_agent_screen_question=
	prime_agent_screen_frame=1
	prime_agent_screen_cols="$1"
	prime_agent_screen_rows="$2"
	prime_agent_screen_layout_ready=0
	prime_agent_screen_layout_show_logo=0
	prime_agent_screen_layout_lab_width=0
	prime_agent_screen_render_lab_width=0
	prime_agent_screen_compact=0
	prime_agent_init_screen_layout
	prime_agent_refresh_screen_layout_mode
	print_render_meta first
	printf '__RENDER_START__ first\\n'
	prime_agent_render_screen
	printf '__RENDER_END__ first\\n'

	prime_agent_screen_frame=2
	prime_agent_screen_cols="$3"
	prime_agent_screen_rows="$4"
	prime_agent_refresh_screen_layout_mode
	print_render_meta second
	printf '__RENDER_START__ second\\n'
	prime_agent_render_screen
	printf '__RENDER_END__ second\\n'
}

progress_case() {
	progress_details="Preparing global install.
Linking command binaries.
Finalizing npm install."
	for progress_frame in 1 24 25 48 49 200; do
		prime_agent_animation_frame="$progress_frame"
		printf '__PROGRESS__ %s\t%s\t%s\t%s\\n' "$progress_frame" "$(prime_agent_animation_percent "$progress_details")" "$(prime_agent_animation_status "Installing Prime Agent" "$progress_details" static)" "$(prime_agent_animation_detail "$progress_details")"
	done
}

render_case "$@"
progress_case
`;

const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-installer-render-"));
const harnessPath = join(tempDir, "harness.sh");

try {
	writeFileSync(harnessPath, harnessSource, "utf-8");

	const stableVisible = runCase("stable visible logo", 100, 30, 90, 30);
	check(stableVisible.meta.first.visible === "1", "expected the initial large render to show the logo");
	check(stableVisible.meta.second.visible === "1", "expected a safe resize to keep showing the logo");
	check(
		stableVisible.meta.first.lab_width === stableVisible.meta.second.lab_width,
		"expected logo lab width to stay stable across a safe resize",
	);
	assertInstallerProgress(stableVisible.progress);

	const stableExpand = runCase("stable expanded logo", 60, 24, 120, 32);
	check(stableExpand.meta.first.visible === "1", "expected the initial medium render to show the logo");
	check(stableExpand.meta.second.visible === "1", "expected terminal growth to keep showing the logo");
	check(
		stableExpand.meta.first.lab_width === stableExpand.meta.second.lab_width,
		"expected logo lab width not to grow after terminal expansion",
	);

	const noLogoStart = runCase("small initial terminal", 41, 24, 100, 30);
	check(noLogoStart.meta.first.layout_show_logo === "0", "expected a too-narrow initial terminal to freeze text-only layout");
	check(noLogoStart.meta.second.visible === "0", "expected terminal growth not to enable a logo after text-only layout was frozen");

	const narrowLogo = runCase("narrow logo on width shrink", 100, 30, 60, 24);
	check(narrowLogo.meta.first.visible === "1", "expected the initial wide render to show the logo");
	check(narrowLogo.meta.second.compact === "0", "expected shrink below frozen lab width to keep rendering the logo");
	check(narrowLogo.meta.second.visible === "1", "expected narrow width mode to keep showing the logo");
	check(
		Number(narrowLogo.meta.second.render_lab_width) <= 59,
		"expected narrow width mode to keep the rendered lab width inside the resized terminal",
	);

	const compactWidth = runCase("compact on severe width shrink", 100, 30, 32, 24);
	check(compactWidth.meta.first.visible === "1", "expected the initial wide render to show the logo");
	check(compactWidth.meta.second.compact === "1", "expected shrink below logo width to use compact mode");
	check(compactWidth.meta.second.visible === "0", "expected severe compact width mode to hide the logo");

	const compactRows = runCase("compact on row shrink", 100, 30, 100, 10);
	check(compactRows.meta.first.visible === "1", "expected the initial tall render to show the logo");
	check(compactRows.meta.second.compact === "1", "expected shrink below frozen splash height to use compact mode");
	check(compactRows.meta.second.visible === "0", "expected compact row mode to hide the logo");
} finally {
	rmSync(tempDir, { recursive: true, force: true });
}

if (failures.length > 0) {
	console.error(["Installer render check failed:", ...failures.map((failure) => `- ${failure}`)].join("\n"));
	process.exit(1);
}

console.log("Installer render check passed.");

function runCase(name, initialCols, initialRows, resizedCols, resizedRows) {
	const result = spawnSync("sh", [harnessPath, String(initialCols), String(initialRows), String(resizedCols), String(resizedRows)], {
		encoding: "utf-8",
	});
	if (result.status !== 0) {
		failures.push(`${name}: harness exited with ${result.status ?? "unknown"}\n${result.stderr}${result.stdout}`);
		return emptyParsedCase();
	}

	const parsed = parseRenderOutput(result.stdout);
	assertLineWidths(name, "first", parsed, initialCols, initialRows);
	assertLineWidths(name, "second", parsed, resizedCols, resizedRows);
	return parsed;
}

function parseRenderOutput(output) {
	const parsed = emptyParsedCase();
	let activeRender = null;

	for (const rawLine of output.split("\n")) {
		const line = rawLine.replace(/\r$/, "");
		if (line.startsWith("__META__ ")) {
			const [, label, ...fields] = line.split(" ");
			parsed.meta[label] = Object.fromEntries(fields.map((field) => field.split("=")));
			continue;
		}
		if (line.startsWith("__RENDER_START__ ")) {
			activeRender = line.slice("__RENDER_START__ ".length);
			parsed.renders[activeRender] = [];
			continue;
		}
		if (line.startsWith("__RENDER_END__ ")) {
			activeRender = null;
			continue;
		}
		if (line.startsWith("__PROGRESS__ ")) {
			const [frame, percent, status, detail] = line.slice("__PROGRESS__ ".length).split("\t");
			parsed.progress.push({ frame: Number(frame), percent: Number(percent), status, detail });
			continue;
		}
		if (activeRender) {
			parsed.renders[activeRender].push(line.replace(ansiPattern, ""));
		}
	}

	return parsed;
}

function assertInstallerProgress(progress) {
	check(progress.length === 6, `expected six progress samples, got ${progress.length}`);
	if (progress.length !== 6) return;

	const expectedDetails = [
		"Preparing global install.",
		"Preparing global install.",
		"Linking command binaries.",
		"Linking command binaries.",
		"Finalizing npm install.",
		"Finalizing npm install.",
	];
	for (const [index, expectedDetail] of expectedDetails.entries()) {
		check(
			progress[index].detail === expectedDetail,
			`expected progress sample ${index + 1} to show "${expectedDetail}", got "${progress[index].detail}"`,
		);
		check(
			progress[index].status === `Installing Prime Agent · ${progress[index].percent}%`,
			`expected progress sample ${index + 1} to include percent in the status`,
		);
	}

	for (let index = 1; index < progress.length; index++) {
		check(
			progress[index].percent >= progress[index - 1].percent,
			`expected progress percent to be monotonic between samples ${index} and ${index + 1}`,
		);
	}
	check(progress[0].percent > 0, "expected progress percent to start above zero");
	check(progress[progress.length - 1].percent === 99, "expected in-flight progress percent to cap at 99");
}

function assertLineWidths(name, label, parsed, cols, rows) {
	const lines = parsed.renders[label] ?? [];
	check(lines.length === rows, `${name}: expected ${label} render to have ${rows} rows, got ${lines.length}`);

	const maxWidth = Math.max(cols - 1, 0);
	for (const [index, line] of lines.entries()) {
		check(line.length <= maxWidth, `${name}: ${label} render line ${index + 1} reached ${line.length} columns in a ${cols}-column terminal`);
	}
}

function check(condition, message) {
	if (!condition) {
		failures.push(message);
	}
}

function emptyParsedCase() {
	return {
		meta: {
			first: {},
			second: {},
		},
		renders: {
			first: [],
			second: [],
		},
		progress: [],
	};
}
