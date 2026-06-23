import chalk from "chalk";
import { formatSessionDisplayId } from "../modes/daemon/daemon-session-id.js";
import type { SessionStatus, SessionSummary } from "../modes/daemon/daemon-session-list.js";

const LIST_STATUS_ORDER: Record<SessionStatus, number> = {
	user: 0,
	idle: 1,
	tool: 2,
	model: 3,
	active: 4,
	sleep: 5,
	crash: 6,
};

type ListRow = {
	name: string;
	id: string;
	status: SessionStatus;
	age: string;
	model: string;
	messages: string;
	clients: string;
};

export function formatSessionListTable(sessions: readonly SessionSummary[], nowMs = Date.now()): string {
	const rows = sortSessionsForList(sessions).map((session) => ({
		name: session.sessionName ?? "",
		id: formatSessionDisplayId(session.id),
		status: session.status,
		age: formatSessionAge(session.modified, nowMs),
		model: formatSessionModel(session.model),
		messages: String(session.messageCount),
		clients: String(session.attachedClients),
	}));
	return formatTable(["name", "id", "status", "age", "model", "messages", "clients"], rows, formatListCell);
}

function sortSessionsForList(sessions: readonly SessionSummary[]): SessionSummary[] {
	return sessions
		.map((session, index) => ({ session, index }))
		.sort((left, right) => {
			const statusDelta = LIST_STATUS_ORDER[left.session.status] - LIST_STATUS_ORDER[right.session.status];
			return statusDelta || left.index - right.index;
		})
		.map(({ session }) => session);
}

function formatListCell(row: ListRow, column: keyof ListRow, value: string): string {
	if (column !== "status") {
		return value;
	}

	switch (row.status) {
		case "tool":
		case "model":
			return chalk.red(value);
		case "user":
		case "idle":
			return chalk.blue(value);
		case "active":
		case "sleep":
		case "crash":
			return chalk.dim(value);
	}
}

function formatSessionAge(modified: string | undefined, nowMs: number): string {
	if (!modified) {
		return "";
	}
	const modifiedMs = new Date(modified).getTime();
	if (Number.isNaN(modifiedMs)) {
		return "";
	}
	const ageSeconds = Math.max(0, Math.floor((nowMs - modifiedMs) / 1000));
	if (ageSeconds < 60) {
		return `${ageSeconds}s`;
	}
	const ageMinutes = Math.floor(ageSeconds / 60);
	if (ageMinutes < 60) {
		return `${ageMinutes}m`;
	}
	const ageHours = Math.floor(ageMinutes / 60);
	if (ageHours < 24) {
		return `${ageHours}h`;
	}
	const ageDays = Math.floor(ageHours / 24);
	if (ageDays < 7) {
		return `${ageDays}d`;
	}
	const ageWeeks = Math.floor(ageDays / 7);
	if (ageWeeks < 52) {
		return `${ageWeeks}w`;
	}
	return `${Math.floor(ageWeeks / 52)}y`;
}

function formatSessionModel(model: SessionSummary["model"]): string {
	return model ? `${model.provider}/${model.id}` : "";
}

function formatTable<T extends Record<string, string>>(
	columns: Array<keyof T>,
	rows: T[],
	formatCell?: (row: T, column: keyof T, value: string) => string,
): string {
	const widths = columns.map((column) =>
		Math.max(String(column).length, ...rows.map((row) => String(row[column]).length)),
	);
	const lines = [columns.map((column, index) => String(column).padEnd(widths[index])).join("  ")];
	for (const row of rows) {
		const line = columns
			.map((column, index) => {
				const value = String(row[column]).padEnd(widths[index]);
				return formatCell ? formatCell(row, column, value) : value;
			})
			.join("  ");
		lines.push(line);
	}
	return lines.join("\n");
}
