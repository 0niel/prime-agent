import type { AgentConnectionQueueState } from "../agent-connection/types.js";

export type PendingMessageLane = "steering" | "followUp";
export interface PendingMessageLocation {
	lane: PendingMessageLane;
	index: number;
}
export interface PendingMessageChange {
	queue: AgentConnectionQueueState;
	draft: string;
	selected?: PendingMessageLocation;
}

type Item = PendingMessageLocation & { text: string };
const clone = (queue: AgentConnectionQueueState): AgentConnectionQueueState => ({
	steering: [...queue.steering],
	followUp: [...queue.followUp],
});
const items = (queue: AgentConnectionQueueState): Item[] => [
	...queue.steering.map((text, index) => ({ lane: "steering" as const, index, text })),
	...queue.followUp.map((text, index) => ({ lane: "followUp" as const, index, text })),
];
const equal = (a: AgentConnectionQueueState, b: AgentConnectionQueueState): boolean =>
	a.steering.length === b.steering.length &&
	a.followUp.length === b.followUp.length &&
	a.steering.every((text, index) => text === b.steering[index]) &&
	a.followUp.every((text, index) => text === b.followUp[index]);

/** Pending-message history plus all pure mutations of its selected item. */
export class PendingMessageNavigation {
	private queue?: AgentConnectionQueueState;
	private cursor = 0;
	private draft = "";
	private edits = new Map<number, string>();

	get selected(): PendingMessageLocation | undefined {
		const item = this.queue && items(this.queue)[this.cursor];
		return item ? { lane: item.lane, index: item.index } : undefined;
	}
	get draftText(): string {
		return this.draft;
	}
	get isAtDraft(): boolean {
		return !!this.queue && this.cursor === items(this.queue).length;
	}

	reset(): void {
		this.queue = undefined;
		this.cursor = 0;
		this.draft = "";
		this.edits.clear();
	}

	sync(queue: AgentConnectionQueueState): boolean {
		if (!this.queue || equal(this.queue, queue)) return false;
		this.reset();
		return true;
	}

	select(queue: AgentConnectionQueueState, draft: string, selected: PendingMessageLocation): string | undefined {
		const cursor = items(queue).findIndex((item) => item.lane === selected.lane && item.index === selected.index);
		if (cursor < 0) return undefined;
		this.queue = clone(queue);
		this.cursor = cursor;
		this.draft = draft;
		this.edits.clear();
		return this.value(cursor);
	}

	browse(queue: AgentConnectionQueueState, text: string, delta: -1 | 1): string | undefined {
		if (!this.queue || !equal(this.queue, queue)) {
			if (delta > 0 || items(queue).length === 0) return undefined;
			this.queue = clone(queue);
			this.cursor = items(queue).length;
			this.draft = text;
			this.edits.clear();
		} else this.capture(text);
		const end = items(this.queue).length;
		this.cursor = Math.max(0, Math.min(end, this.cursor + delta));
		return this.cursor === end ? this.draft : this.value(this.cursor);
	}

	private value(index: number): string {
		return this.edits.get(index) ?? items(this.queue!)[index]!.text;
	}

	capture(text: string): void {
		if (!this.queue) return;
		if (this.cursor < items(this.queue).length) this.edits.set(this.cursor, text);
		else this.draft = text;
	}

	/** Mutate the selected item, preserving its edit on reorder and returning to the draft otherwise. */
	change(kind: "delete" | "followUp" | "steer" | "earlier" | "later", text: string): PendingMessageChange | undefined {
		const selected = this.selected;
		if (!this.queue || !selected) return undefined;
		const queue = clone(this.queue);
		if (kind === "earlier" || kind === "later") {
			const target = selected.index + (kind === "earlier" ? -1 : 1);
			const lane = queue[selected.lane];
			if (target < 0 || target >= lane.length) return undefined;
			[lane[selected.index], lane[target]] = [lane[target]!, lane[selected.index]!];
			const moved = { lane: selected.lane, index: target };
			this.select(queue, this.draft, moved);
			this.edits.set(this.cursor, text);
			return { queue, draft: text, selected: moved };
		}
		queue[selected.lane].splice(selected.index, 1);
		if (kind === "followUp")
			queue.followUp.splice(selected.lane === "followUp" ? selected.index : queue.followUp.length, 0, text);
		const draft = this.draft;
		this.reset();
		return { queue, draft };
	}
}
