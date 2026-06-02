import type {
	ExtensionCommandContextActions,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
	WorkingIndicatorOptions,
} from "../../core/extensions/index.js";
import { type Theme, theme } from "../interactive/theme/theme.js";
import type { ActiveSessionState } from "./active-session-state.js";
import type { DaemonOutbound } from "./daemon-protocol.js";

export interface ActiveSessionBindingCallbacks {
	broadcast: (state: ActiveSessionState, message: DaemonOutbound) => void;
	shutdown: () => void;
}

export async function bindActiveSessionState(
	state: ActiveSessionState,
	callbacks: ActiveSessionBindingCallbacks,
): Promise<void> {
	const session = state.runtime.session;

	state.unsubscribe?.();
	state.unsubscribe = session.subscribe((event) => {
		callbacks.broadcast(state, {
			type: "session_event",
			activeSessionId: state.activeSessionId,
			event,
		});
	});

	state.runtime.setRebindSession(async () => {
		await bindActiveSessionState(state, callbacks);
	});

	await session.bindExtensions({
		uiContext: createExtensionUIContext(state, callbacks.broadcast),
		commandContextActions: createCommandContextActions(state),
		shutdownHandler: callbacks.shutdown,
		onError: (error) => {
			callbacks.broadcast(state, {
				type: "extension_error",
				activeSessionId: state.activeSessionId,
				extensionPath: error.extensionPath,
				event: error.event,
				error: error.error,
			});
		},
	});
}

function createCommandContextActions(state: ActiveSessionState): ExtensionCommandContextActions {
	return {
		waitForIdle: () => state.runtime.session.agent.waitForIdle(),
		newSession: async (options) => state.runtime.newSession(options),
		fork: async (entryId, options) => {
			const result = await state.runtime.fork(entryId, options);
			return { cancelled: result.cancelled };
		},
		navigateTree: async (targetId, options) => {
			const result = await state.runtime.session.navigateTree(targetId, {
				summarize: options?.summarize,
				customInstructions: options?.customInstructions,
				replaceInstructions: options?.replaceInstructions,
				label: options?.label,
			});
			return { cancelled: result.cancelled };
		},
		switchSession: async (sessionPath, options) => state.runtime.switchSession(sessionPath, options),
		reload: async () => {
			await state.runtime.session.reload();
		},
	};
}

function createExtensionUIContext(
	state: ActiveSessionState,
	broadcast: ActiveSessionBindingCallbacks["broadcast"],
): ExtensionUIContext {
	const emitUiRequest = (method: string, payload: Record<string, unknown>): void => {
		broadcast(state, {
			type: "extension_ui_request",
			activeSessionId: state.activeSessionId,
			method,
			payload,
		});
	};

	const dialogDefault = <T>(opts: ExtensionUIDialogOptions | undefined, fallback: T): Promise<T> => {
		if (opts?.signal?.aborted) {
			return Promise.resolve(fallback);
		}
		return new Promise((resolveDialog) => {
			let timeoutId: ReturnType<typeof setTimeout> | undefined;
			const cleanup = () => {
				if (timeoutId) {
					clearTimeout(timeoutId);
				}
				opts?.signal?.removeEventListener("abort", onAbort);
			};
			const finish = () => {
				cleanup();
				resolveDialog(fallback);
			};
			const onAbort = () => finish();
			opts?.signal?.addEventListener("abort", onAbort, { once: true });
			if (opts?.timeout !== undefined) {
				timeoutId = setTimeout(finish, opts.timeout);
			} else {
				timeoutId = setTimeout(finish, 0);
			}
		});
	};

	return {
		select: (title, values, opts) => {
			emitUiRequest("select", { title, options: values, timeout: opts?.timeout });
			return dialogDefault(opts, undefined);
		},
		confirm: (title, message, opts) => {
			emitUiRequest("confirm", { title, message, timeout: opts?.timeout });
			return dialogDefault(opts, false);
		},
		input: (title, placeholder, opts) => {
			emitUiRequest("input", { title, placeholder, timeout: opts?.timeout });
			return dialogDefault(opts, undefined);
		},
		notify: (message, notifyType) => emitUiRequest("notify", { message, notifyType }),
		onTerminalInput: () => () => {},
		setStatus: (key, text) => emitUiRequest("setStatus", { statusKey: key, statusText: text }),
		setWorkingMessage: (message) => emitUiRequest("setWorkingMessage", { message }),
		setWorkingVisible: (visible) => emitUiRequest("setWorkingVisible", { visible }),
		setWorkingIndicator: (indicatorOptions?: WorkingIndicatorOptions) =>
			emitUiRequest("setWorkingIndicator", { options: indicatorOptions }),
		setHiddenThinkingLabel: (label) => emitUiRequest("setHiddenThinkingLabel", { label }),
		setWidget: (key: string, content: unknown, widgetOptions?: ExtensionWidgetOptions) => {
			if (content === undefined || Array.isArray(content)) {
				emitUiRequest("setWidget", {
					widgetKey: key,
					widgetLines: content,
					widgetPlacement: widgetOptions?.placement,
				});
			}
		},
		setFooter: () => {},
		setHeader: () => {},
		setTitle: (title) => emitUiRequest("setTitle", { title }),
		async custom<T>(): Promise<T> {
			return undefined as T;
		},
		pasteToEditor: (text) => emitUiRequest("setEditorText", { text }),
		setEditorText: (text) => emitUiRequest("setEditorText", { text }),
		getEditorText: () => "",
		editor: (title, prefill) => {
			emitUiRequest("editor", { title, prefill });
			return Promise.resolve(undefined);
		},
		addAutocompleteProvider: () => {},
		setEditorComponent: () => {},
		getEditorComponent: () => undefined,
		get theme(): Theme {
			return theme;
		},
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: () => ({ success: false, error: "Theme switching is not supported in daemon mode" }),
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
	};
}
