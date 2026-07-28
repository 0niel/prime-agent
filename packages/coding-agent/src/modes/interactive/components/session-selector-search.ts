import { fuzzyMatch } from "@earendil-works/pi-tui";
import type { AgentConnectionSavedSessionInfo } from "../../agent-connection/index.js";

export type SortMode = "threaded" | "recent" | "relevance";

export type NameFilter = "all" | "named";

export interface ParsedSearchQuery {
	mode: "tokens" | "regex";
	tokens: { kind: "fuzzy" | "phrase"; value: string }[];
	regex: RegExp | null;
	/** If set, parsing failed and we should treat query as non-matching. */
	error?: string;
}

export interface MatchResult {
	matches: boolean;
	/** Lower is better; only meaningful when matches === true */
	score: number;
}

function normalizeWhitespaceLower(text: string): string {
	return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function normalizeSessionTitle(value: string | undefined): string {
	if (value === "(no messages)" || value === "(large message)") return "";
	return normalizeWhitespaceLower(value ?? "");
}

function getSessionSearchText(session: AgentConnectionSavedSessionInfo): string {
	return `${session.id} ${session.name ?? ""} ${session.allMessagesText} ${session.cwd}`;
}

export function hasSessionName(session: AgentConnectionSavedSessionInfo): boolean {
	return Boolean(session.name?.trim());
}

function matchesNameFilter(session: AgentConnectionSavedSessionInfo, filter: NameFilter): boolean {
	if (filter === "all") return true;
	return hasSessionName(session);
}

function compareSessionsByModifiedDesc(a: AgentConnectionSavedSessionInfo, b: AgentConnectionSavedSessionInfo): number {
	const modifiedDiff = b.modified.getTime() - a.modified.getTime();
	if (modifiedDiff !== 0) return modifiedDiff;
	const createdDiff = b.created.getTime() - a.created.getTime();
	if (createdDiff !== 0) return createdDiff;
	return a.path.localeCompare(b.path);
}

export function parseSearchQuery(query: string): ParsedSearchQuery {
	const trimmed = query.trim();
	if (!trimmed) {
		return { mode: "tokens", tokens: [], regex: null };
	}

	// Regex mode: re:<pattern>
	if (trimmed.startsWith("re:")) {
		const pattern = trimmed.slice(3).trim();
		if (!pattern) {
			return { mode: "regex", tokens: [], regex: null, error: "Empty regex" };
		}
		try {
			return { mode: "regex", tokens: [], regex: new RegExp(pattern, "i") };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return { mode: "regex", tokens: [], regex: null, error: msg };
		}
	}

	// Token mode with quote support.
	// Example: foo "node cve" bar
	const tokens: { kind: "fuzzy" | "phrase"; value: string }[] = [];
	let buf = "";
	let inQuote = false;
	let hadUnclosedQuote = false;

	const flush = (kind: "fuzzy" | "phrase"): void => {
		const v = buf.trim();
		buf = "";
		if (!v) return;
		tokens.push({ kind, value: v });
	};

	for (let i = 0; i < trimmed.length; i++) {
		const ch = trimmed[i]!;
		if (ch === '"') {
			if (inQuote) {
				flush("phrase");
				inQuote = false;
			} else {
				flush("fuzzy");
				inQuote = true;
			}
			continue;
		}

		if (!inQuote && /\s/.test(ch)) {
			flush("fuzzy");
			continue;
		}

		buf += ch;
	}

	if (inQuote) {
		hadUnclosedQuote = true;
	}

	// If quotes were unbalanced, fall back to plain whitespace tokenization.
	if (hadUnclosedQuote) {
		return {
			mode: "tokens",
			tokens: trimmed
				.split(/\s+/)
				.map((t) => t.trim())
				.filter((t) => t.length > 0)
				.map((t) => ({ kind: "fuzzy" as const, value: t })),
			regex: null,
		};
	}

	flush(inQuote ? "phrase" : "fuzzy");

	return { mode: "tokens", tokens, regex: null };
}

const STRICT_FUZZY_MAX_TOKEN_SCORE = 25;
const SCORE_TIER_SIZE = 1000;

export function matchSession(session: AgentConnectionSavedSessionInfo, parsed: ParsedSearchQuery): MatchResult {
	const text = getSessionSearchText(session);

	if (parsed.mode === "regex") {
		if (!parsed.regex) return { matches: false, score: 0 };
		const idx = text.search(parsed.regex);
		return idx < 0 ? { matches: false, score: 0 } : { matches: true, score: idx * 0.1 };
	}
	if (parsed.tokens.length === 0) return { matches: true, score: 0 };

	const titles = [session.name, session.firstMessage].map(normalizeSessionTitle);
	if (parsed.tokens.length > 1 && parsed.tokens.every((token) => token.kind === "fuzzy")) {
		const query = parsed.tokens.map((token) => normalizeWhitespaceLower(token.value)).join(" ");
		const exact = titles.indexOf(query);
		const prefix = titles.findIndex((title) => title.startsWith(query));
		const substring = titles.findIndex((title) => title.includes(query));
		if (exact >= 0) return { matches: true, score: exact };
		if (prefix >= 0) return { matches: true, score: SCORE_TIER_SIZE + prefix };
		if (substring >= 0) return { matches: true, score: SCORE_TIER_SIZE * 2 + substring };
	}

	const normalizedText = normalizeWhitespaceLower(text);
	let worstTier = 0;
	let tieScore = 0;
	let matchedTokens = 0;
	for (const token of parsed.tokens) {
		const needle = normalizeWhitespaceLower(token.value);
		if (!needle) continue;
		const exact = titles.indexOf(needle);
		const prefix = titles.findIndex((title) => title.startsWith(needle));
		const substring = titles.findIndex((title) => title.includes(needle));
		let tier: number;
		let tie: number;
		if (exact >= 0) [tier, tie] = [3, exact];
		else if (prefix >= 0) [tier, tie] = [4, prefix];
		else if (substring >= 0) [tier, tie] = [5, substring];
		else {
			const position = normalizedText.indexOf(needle);
			if (position >= 0) [tier, tie] = [6, position];
			else {
				if (token.kind === "phrase") return { matches: false, score: 0 };
				const match = fuzzyMatch(token.value, text);
				if (!match.matches || match.score > STRICT_FUZZY_MAX_TOKEN_SCORE) return { matches: false, score: 0 };
				[tier, tie] = [7, match.score];
			}
		}
		worstTier = Math.max(worstTier, tier);
		tieScore += 0.5 + Math.atan(tie) / Math.PI;
		matchedTokens++;
	}
	return { matches: true, score: worstTier * SCORE_TIER_SIZE + tieScore / Math.max(1, matchedTokens) };
}

export function filterAndSortSessions(
	sessions: AgentConnectionSavedSessionInfo[],
	query: string,
	sortMode: SortMode,
	nameFilter: NameFilter = "all",
): AgentConnectionSavedSessionInfo[] {
	const nameFiltered =
		nameFilter === "all" ? sessions : sessions.filter((session) => matchesNameFilter(session, nameFilter));
	const trimmed = query.trim();
	if (!trimmed) {
		return sortMode === "recent" ? [...nameFiltered].sort(compareSessionsByModifiedDesc) : nameFiltered;
	}

	const parsed = parseSearchQuery(query);
	if (parsed.error) return [];

	// Recent mode: filter, then order by the latest user or assistant message.
	if (sortMode === "recent") {
		const filtered: AgentConnectionSavedSessionInfo[] = [];
		for (const s of nameFiltered) {
			const res = matchSession(s, parsed);
			if (res.matches) filtered.push(s);
		}
		return filtered.sort(compareSessionsByModifiedDesc);
	}

	// Relevance mode: sort by score, tie-break by modified desc.
	const scored: { session: AgentConnectionSavedSessionInfo; score: number }[] = [];
	for (const s of nameFiltered) {
		const res = matchSession(s, parsed);
		if (!res.matches) continue;
		scored.push({ session: s, score: res.score });
	}

	scored.sort((a, b) => {
		if (a.score !== b.score) return a.score - b.score;
		return compareSessionsByModifiedDesc(a.session, b.session);
	});

	return scored.map((r) => r.session);
}
