// Shared "still working" indicator used across the agents view, the chat
// subagent tray, and in-progress tool markers so motion reads consistently.
export const WORKING_ICON_FRAMES = ["◇", "◈", "◆", "◈"] as const;
export const WORKING_ICON_INTERVAL_MS = 250;

export function workingIconFrame(frame: number): string {
	const frames = WORKING_ICON_FRAMES;
	return frames[((frame % frames.length) + frames.length) % frames.length] ?? frames[0];
}

// Second-precise clock used by live timers so the display keeps moving.
export function formatLiveDuration(durationMs: number): string {
	const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const seconds = (totalSeconds % 60).toString().padStart(2, "0");
	const totalMinutes = Math.floor(totalSeconds / 60);
	if (totalMinutes < 60) return `${totalMinutes}:${seconds}`;
	const minutes = (totalMinutes % 60).toString().padStart(2, "0");
	return `${Math.floor(totalMinutes / 60)}:${minutes}:${seconds}`;
}

// Compact human-readable duration for settled work.
export function formatDuration(durationMs: number): string {
	const seconds = Math.max(0, Math.floor(durationMs / 1000));
	if (seconds < 60) {
		return `${seconds}s`;
	}
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) {
		return `${minutes}m`;
	}
	return `${Math.floor(minutes / 60)}h`;
}

// Process-wide frame counter for in-place chat tool markers, advanced by the
// interactive mode's single ticker and read during render.
let pulseFrame = 0;

export function getWorkingPulseFrame(): number {
	return pulseFrame;
}

export function setWorkingPulseFrame(frame: number): void {
	pulseFrame = frame;
}
