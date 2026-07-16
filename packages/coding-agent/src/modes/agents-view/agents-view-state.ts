import { basename } from "node:path";
import type { SessionSummary } from "../daemon/daemon-session-list.js";

export type AgentsViewSection = "working" | "needs-input" | "heartbeats" | "completed";

export type AgentsViewRowKind = "agent" | "subagent-summary" | "subagent" | "subagent-code";

// Hard cap on spawn-code lines shown so a large program never floods the view.
const MAX_SPAWN_CODE_LINES = 10;

export interface AgentsViewRow {
	kind: AgentsViewRowKind;
	section: AgentsViewSection;
	summary: SessionSummary;
	title: string;
	subtitle: string;
	statusLabel: string;
	depth: number;
	selectable: boolean;
	runningSubagentCount: number;
	/** Unique selection identity for this row. */
	identity: string;
	/** Identity of the agent row this row is nested under. */
	parentIdentity?: string;
	/** True when this row's subagents carry spawn code that can be revealed. */
	hasSpawnCode?: boolean;
	/** One source line of the spawn cell, for "subagent-code" rows. */
	code?: string;
}

export function classifyAgentsViewSession(summary: SessionSummary): AgentsViewSection {
	if (summary.hasActiveHeartbeat) {
		return "heartbeats";
	}
	if (summary.activity === "working") {
		return "working";
	}
	// Idle defaults to Needs Input; only an explicit completed verdict moves it on.
	return summary.taskState === "completed" ? "completed" : "needs-input";
}

// Live sessions only; drafts and archived stay out.
export function shouldShowAgentsViewSession(summary: SessionSummary, manuallyInactive = false): boolean {
	if (manuallyInactive) {
		return false;
	}
	return summary.lifecycle === "live";
}

export function sectionTitle(section: AgentsViewSection): string {
	switch (section) {
		case "working":
			return "Working";
		case "needs-input":
			return "Needs Input";
		case "heartbeats":
			return "Heartbeats";
		case "completed":
			return "Completed";
		default: {
			const _exhaustive: never = section;
			return _exhaustive;
		}
	}
}

export function getAgentsViewSummaryIdentity(summary: SessionSummary): string {
	if (summary.sessionFile) {
		return `file:${summary.sessionFile}`;
	}
	if (summary.activeSessionId) {
		return `active:${summary.activeSessionId}`;
	}
	return `session:${summary.sessionId}`;
}

export interface AgentsViewSelectionKey {
	sessionId: string;
	activeSessionId?: string;
}

export function getAgentsViewSelectionKey(summary: SessionSummary): AgentsViewSelectionKey {
	return { sessionId: summary.sessionId, activeSessionId: summary.activeSessionId };
}

// Matches by identity, then activeSessionId, then sessionId: a row's identity
// changes when a session is persisted or re-attached, so the latter two keys
// re-find the same session across those transitions. Returns -1 when gone.
export function resolveAgentsViewSelectionIndex(
	rows: readonly AgentsViewRow[],
	identity: string | undefined,
	key: AgentsViewSelectionKey | undefined,
): number {
	const findSelectable = (predicate: (row: AgentsViewRow) => boolean): number =>
		rows.findIndex((row) => row.selectable && predicate(row));

	if (identity !== undefined) {
		const index = findSelectable((row) => row.identity === identity);
		if (index >= 0) {
			return index;
		}
	}
	if (key?.activeSessionId !== undefined) {
		const activeSessionId = key.activeSessionId;
		const index = findSelectable((row) => (row.summary.activeSessionId ?? row.summary.id) === activeSessionId);
		if (index >= 0) {
			return index;
		}
	}
	if (key?.sessionId !== undefined) {
		const sessionId = key.sessionId;
		return findSelectable((row) => row.summary.sessionId === sessionId);
	}
	return -1;
}

export function buildAgentsViewRows(
	summaries: readonly SessionSummary[],
	expandedSubagentParents: ReadonlySet<string> = new Set(),
	programShownParents: ReadonlySet<string> = new Set(),
): AgentsViewRow[] {
	const baseRows = summaries.map(
		(summary): MutableAgentsViewRow => ({
			kind: isSubagentSummary(summary) ? "subagent" : "agent",
			section: classifyAgentsViewSession(summary),
			summary,
			title: getSessionTitle(summary),
			subtitle: getSessionSubtitle(summary),
			statusLabel: getSessionStatusLabel(summary),
			depth: 0,
			selectable: true,
			runningSubagentCount: 0,
			identity: getAgentsViewSummaryIdentity(summary),
		}),
	);
	const rowsByKey = buildRowKeyMap(baseRows);
	const childrenByParent = new Map<MutableAgentsViewRow, MutableAgentsViewRow[]>();
	const nestedRows = new Set<MutableAgentsViewRow>();

	for (const row of baseRows) {
		if (row.kind !== "subagent") {
			continue;
		}
		nestedRows.add(row);
		const parent = findParentRow(row.summary, rowsByKey);
		if (!parent || parent === row) {
			continue;
		}
		if (row.summary.activity === "working") {
			parent.runningSubagentCount += 1;
		}
		const siblings = childrenByParent.get(parent) ?? [];
		siblings.push(row);
		childrenByParent.set(parent, siblings);
	}

	const roots = baseRows.filter((row) => !nestedRows.has(row));
	const flattened: AgentsViewRow[] = [];
	const emit = (row: MutableAgentsViewRow, depth: number): void => {
		row.depth = depth;
		flattened.push(row);
		const children = childrenByParent.get(row) ?? [];
		if (children.length === 0) {
			return;
		}
		const childHasSpawnCode = children.some((child) => hasSpawnCode(child.summary));
		if (expandedSubagentParents.has(row.identity)) {
			const showProgram = programShownParents.has(row.identity);
			const groups = groupChildrenBySpawnCode(children.sort(compareAgentsViewRows));
			for (const [groupIndex, group] of groups.entries()) {
				if (showProgram && group.spawnCode) {
					for (const codeRow of buildSpawnCodeRows(row, group.spawnCode, depth + 1, groupIndex)) {
						flattened.push(codeRow);
					}
				}
				for (const child of group.children) {
					child.parentIdentity = row.identity;
					emit(child, depth + 1);
				}
			}
		} else {
			flattened.push(createSubagentSummaryRow(row, children.length, depth + 1, childHasSpawnCode));
		}
	};
	for (const root of roots.sort(compareAgentsViewRows)) {
		emit(root, 0);
	}
	return flattened;
}

type MutableAgentsViewRow = AgentsViewRow;

function createSubagentSummaryRow(
	parent: AgentsViewRow,
	totalCount: number,
	depth: number,
	hasSpawnCode: boolean,
): AgentsViewRow {
	const running = parent.runningSubagentCount;
	// Finished subagents stay reachable through the summary row even when
	// nothing is running anymore.
	const title =
		running > 0
			? `${running} ${running === 1 ? "subagent" : "subagents"} running`
			: `${totalCount} ${totalCount === 1 ? "subagent" : "subagents"}`;
	return {
		kind: "subagent-summary",
		section: parent.section,
		summary: parent.summary,
		title,
		subtitle: "",
		statusLabel: "",
		depth,
		selectable: true,
		runningSubagentCount: running,
		identity: `subagents:${parent.identity}`,
		parentIdentity: parent.identity,
		hasSpawnCode,
	};
}

function hasSpawnCode(summary: SessionSummary): boolean {
	return typeof summary.spawnCode === "string" && summary.spawnCode.trim().length > 0;
}

interface SpawnCodeGroup {
	/** Shared spawn-cell source for this group, or undefined when unavailable. */
	spawnCode?: string;
	children: MutableAgentsViewRow[];
}

// Subagents spawned by the same IPython cell share its source; group them so
// each spawn cell renders once, above the subagents it launched. Different turns
// produce different cells and therefore distinct groups. Insertion order follows
// each cell's first subagent so groups read top-to-bottom in spawn order.
function groupChildrenBySpawnCode(children: readonly MutableAgentsViewRow[]): SpawnCodeGroup[] {
	const NO_CODE_KEY = " no-spawn-code";
	const groups = new Map<string, SpawnCodeGroup>();
	for (const child of children) {
		const code = hasSpawnCode(child.summary) ? child.summary.spawnCode : undefined;
		const key = code ?? NO_CODE_KEY;
		const group = groups.get(key);
		if (group) {
			group.children.push(child);
		} else {
			groups.set(key, { spawnCode: code, children: [child] });
		}
	}
	return [...groups.values()];
}

function buildSpawnCodeRows(
	parent: AgentsViewRow,
	spawnCode: string,
	depth: number,
	groupIndex: number,
): AgentsViewRow[] {
	const makeRow = (code: string, lineIndex: string): AgentsViewRow => ({
		kind: "subagent-code",
		section: parent.section,
		summary: parent.summary,
		title: "",
		subtitle: "",
		statusLabel: "",
		depth,
		// Code rows are read-only context; selection skips over them.
		selectable: false,
		runningSubagentCount: 0,
		identity: `code:${parent.identity}:${groupIndex}:${lineIndex}`,
		parentIdentity: parent.identity,
		code,
	});
	const allLines = spawnCode.replace(/\s+$/, "").split("\n");
	// Cap the body so a long program can't flood the view; note the remainder.
	const lines = allLines.slice(0, MAX_SPAWN_CODE_LINES).map((line, i) => makeRow(line, String(i)));
	const hidden = allLines.length - lines.length;
	if (hidden > 0) {
		lines.push(makeRow(`… +${hidden} more ${hidden === 1 ? "line" : "lines"}`, "more"));
	}
	// A blank panel line above and below pads the program into a clean block.
	return [makeRow("", "pad-top"), ...lines, makeRow("", "pad-bottom")];
}

function compareAgentsViewRows(a: AgentsViewRow, b: AgentsViewRow): number {
	const sectionDiff = sectionRank(a.section) - sectionRank(b.section);
	if (sectionDiff !== 0) {
		return sectionDiff;
	}
	const modifiedDiff = getTimestamp(b.summary.modified) - getTimestamp(a.summary.modified);
	if (modifiedDiff !== 0) {
		return modifiedDiff;
	}
	return a.title.localeCompare(b.title);
}

function buildRowKeyMap(rows: readonly MutableAgentsViewRow[]): Map<string, MutableAgentsViewRow> {
	const rowsByKey = new Map<string, MutableAgentsViewRow>();
	for (const row of rows) {
		for (const key of getSummaryKeys(row.summary)) {
			rowsByKey.set(key, row);
		}
	}
	return rowsByKey;
}

function getSummaryKeys(summary: SessionSummary): string[] {
	return [
		summary.activeSessionId ? `active:${summary.activeSessionId}` : undefined,
		`session:${summary.sessionId}`,
		summary.sessionFile ? `file:${summary.sessionFile}` : undefined,
	].filter((key): key is string => key !== undefined);
}

function findParentRow(
	summary: SessionSummary,
	rowsByKey: ReadonlyMap<string, MutableAgentsViewRow>,
): MutableAgentsViewRow | undefined {
	const keys = [
		summary.parentActiveSessionId ? `active:${summary.parentActiveSessionId}` : undefined,
		summary.parentSessionId ? `session:${summary.parentSessionId}` : undefined,
		summary.parentSessionPath ? `file:${summary.parentSessionPath}` : undefined,
	].filter((key): key is string => key !== undefined);
	for (const key of keys) {
		const row = rowsByKey.get(key);
		if (row) {
			return row;
		}
	}
	return undefined;
}

function isSubagentSummary(summary: SessionSummary): boolean {
	if (summary.runtimeKind) {
		return summary.runtimeKind === "subagent";
	}
	// Summaries from daemons that predate runtimeKind still carry subagent
	// linkage; never surface those as top-level agents.
	return Boolean(
		summary.rlmChildId ?? summary.rlmParentNodeId ?? summary.parentActiveSessionId ?? summary.parentSessionId,
	);
}

function sectionRank(section: AgentsViewSection): number {
	switch (section) {
		case "needs-input":
			return 0;
		case "working":
			return 1;
		case "heartbeats":
			return 2;
		case "completed":
			return 3;
		default: {
			const _exhaustive: never = section;
			return _exhaustive;
		}
	}
}

function getTimestamp(value: string | undefined): number {
	if (!value) {
		return 0;
	}
	const timestamp = Date.parse(value);
	return Number.isNaN(timestamp) ? 0 : timestamp;
}

function getSessionTitle(summary: SessionSummary): string {
	const candidates = [summary.sessionName, summary.firstMessage, basename(summary.cwd), summary.sessionId, summary.id];
	for (const candidate of candidates) {
		const normalized = candidate?.replace(/\s+/g, " ").trim();
		if (normalized) {
			return normalized;
		}
	}
	return "Untitled agent";
}

function getSessionSubtitle(summary: SessionSummary): string {
	const parts = [
		summary.model ? `${summary.model.provider}/${summary.model.id}` : undefined,
		summary.cwd,
		summary.activeSessionId ?? summary.id,
	].filter((part): part is string => part !== undefined && part.length > 0);
	return parts.join("  ");
}

function getSessionStatusLabel(summary: SessionSummary): string {
	if (summary.isCompacting) {
		return "compacting";
	}
	if (summary.isStreaming) {
		return summary.isRunningTools ? "running tools" : "thinking";
	}
	if (summary.pendingMessageCount > 0) {
		return `${summary.pendingMessageCount} queued`;
	}
	if (summary.lifecycle === "archived") {
		return "archived";
	}
	if (summary.hasActiveHeartbeat) {
		return "heartbeat active";
	}
	if (summary.activity === "working") {
		return "classifying";
	}
	return summary.taskState === "completed" ? "completed" : "needs input";
}
