import { basename } from "node:path";
import type { SessionSummary } from "../daemon/daemon-session-list.js";

export type AgentsViewSection = "needs_input" | "working" | "completed";

export interface AgentsViewRow {
	section: AgentsViewSection;
	summary: SessionSummary;
	title: string;
	subtitle: string;
	statusLabel: string;
	depth: number;
	selectable: boolean;
	runningSubagentCount: number;
}

export function classifyAgentsViewSession(summary: SessionSummary): AgentsViewSection {
	if (summary.isStreaming || summary.isCompacting || summary.pendingMessageCount > 0) {
		return "working";
	}
	if (summary.status === "model" || summary.status === "tool") {
		return "working";
	}
	if (summary.status === "user" || summary.messageCount === 0) {
		return "needs_input";
	}
	return "completed";
}

export function shouldShowAgentsViewSession(
	summary: SessionSummary,
	savedStatus: SessionSummary["status"] | undefined = summary.status,
	manuallyInactive = false,
): boolean {
	if (manuallyInactive) {
		return false;
	}
	return summary.activeSessionId !== undefined || savedStatus !== "hidden";
}

export function sectionTitle(section: AgentsViewSection): string {
	switch (section) {
		case "needs_input":
			return "Needs Input";
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

export function buildAgentsViewRows(summaries: readonly SessionSummary[]): AgentsViewRow[] {
	const rows = summaries.map(
		(summary): MutableAgentsViewRow => ({
			section: classifyAgentsViewSession(summary),
			summary,
			title: getSessionTitle(summary),
			subtitle: getSessionSubtitle(summary),
			statusLabel: getSessionStatusLabel(summary),
			depth: 0,
			selectable: !isSubagentSummary(summary),
			runningSubagentCount: 0,
			children: [],
		}),
	);
	const rowsByKey = buildRowKeyMap(rows);
	const nestedRows = new Set<MutableAgentsViewRow>();

	for (const row of rows) {
		if (!isSubagentSummary(row.summary)) {
			continue;
		}
		const parent = findParentRow(row.summary, rowsByKey);
		if (parent && parent !== row && row.section === "working") {
			parent.runningSubagentCount += 1;
		}
		nestedRows.add(row);
	}

	const roots = rows.filter((row) => !nestedRows.has(row));
	return flattenRows(roots);
}

interface MutableAgentsViewRow extends AgentsViewRow {
	children: MutableAgentsViewRow[];
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

function flattenRows(rows: MutableAgentsViewRow[], depth = 0): AgentsViewRow[] {
	const flattened: AgentsViewRow[] = [];
	for (const row of rows.sort(compareAgentsViewRows)) {
		row.depth = depth;
		flattened.push(toAgentsViewRow(row));
		flattened.push(...flattenRows(row.children, depth + 1));
	}
	return flattened;
}

function toAgentsViewRow(row: MutableAgentsViewRow): AgentsViewRow {
	return {
		section: row.section,
		summary: row.summary,
		title: row.title,
		subtitle: row.subtitle,
		statusLabel: row.statusLabel,
		depth: row.depth,
		selectable: row.selectable,
		runningSubagentCount: row.runningSubagentCount,
	};
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
		case "needs_input":
			return 0;
		case "working":
			return 1;
		case "completed":
			return 2;
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
