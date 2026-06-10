import { basename } from "node:path";
import type { SessionSummary } from "../daemon/daemon-session-list.js";

export type AgentsViewSection = "working" | "completed";

export type AgentsViewRowKind = "agent" | "subagent-summary" | "subagent";

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
}

export function classifyAgentsViewSession(summary: SessionSummary): AgentsViewSection {
	if (summary.isStreaming || summary.isCompacting || summary.pendingMessageCount > 0) {
		return "working";
	}
	if (summary.status === "model" || summary.status === "tool") {
		return "working";
	}
	return "completed";
}

// The agents view shows daemon-resident sessions only; saved (slept) sessions
// stay out of the list until they are resumed back into the daemon.
export function shouldShowAgentsViewSession(summary: SessionSummary, manuallyInactive = false): boolean {
	if (manuallyInactive) {
		return false;
	}
	return summary.activeSessionId !== undefined;
}

export function sectionTitle(section: AgentsViewSection): string {
	switch (section) {
		case "working":
			return "Working";
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

export function buildAgentsViewRows(
	summaries: readonly SessionSummary[],
	expandedSubagentParents: ReadonlySet<string> = new Set(),
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
		if (row.section === "working") {
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
		if (expandedSubagentParents.has(row.identity)) {
			for (const child of children.sort(compareAgentsViewRows)) {
				child.parentIdentity = row.identity;
				emit(child, depth + 1);
			}
		} else {
			flattened.push(createSubagentSummaryRow(row, children.length, depth + 1));
		}
	};
	for (const root of roots.sort(compareAgentsViewRows)) {
		emit(root, 0);
	}
	return flattened;
}

type MutableAgentsViewRow = AgentsViewRow;

function createSubagentSummaryRow(parent: AgentsViewRow, totalCount: number, depth: number): AgentsViewRow {
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
	};
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
		case "working":
			return 0;
		case "completed":
			return 1;
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
		return summary.status === "tool" ? "running tools" : "thinking";
	}
	if (summary.pendingMessageCount > 0) {
		return `${summary.pendingMessageCount} queued`;
	}
	if (summary.status === "crash") {
		return "crashed";
	}
	if (summary.status === "sleep") {
		return "saved";
	}
	if (summary.messageCount === 0) {
		return "new";
	}
	return summary.status;
}
