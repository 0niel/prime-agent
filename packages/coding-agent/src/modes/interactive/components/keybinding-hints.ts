/**
 * Utilities for formatting keybinding hints in the UI.
 */

import { getKeybindings, type Keybinding, type KeyId } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.js";

function formatKeyPart(part: string, platform: NodeJS.Platform): string {
	if (platform === "darwin") {
		if (part === "ctrl") return "Cmd";
		if (part === "alt") return "Option";
	}
	return part.charAt(0).toUpperCase() + part.slice(1);
}

export function formatKeyText(key: string, platform: NodeJS.Platform = process.platform): string {
	return key
		.split("/")
		.map((binding) =>
			binding
				.split("+")
				.map((part) => formatKeyPart(part, platform))
				.join("+"),
		)
		.join("/");
}

function formatKeys(keys: KeyId[]): string {
	if (keys.length === 0) return "";
	if (keys.length === 1) return formatKeyText(keys[0]!);
	return formatKeyText(keys.join("/"));
}

export function keyText(keybinding: Keybinding): string {
	return formatKeys(getKeybindings().getKeys(keybinding));
}

export function keyHint(keybinding: Keybinding, description: string): string {
	return theme.fg("dim", keyText(keybinding)) + theme.fg("muted", ` ${description}`);
}

export function rawKeyHint(key: string, description: string): string {
	return theme.fg("dim", key) + theme.fg("muted", ` ${description}`);
}
