import { contextBridge, ipcRenderer } from "electron";

/**
 * Subscribe to a main→renderer notification channel and return a
 * detach function. The detach is critical — Electron's `ipcRenderer.on`
 * keeps listeners across navigations, so a subscription installed by a
 * React component that unmounts (e.g. window-pool window swap) without
 * the matching `removeListener` would leak through every window
 * lifetime, eventually firing a banner against a destroyed React tree.
 *
 * Returning a detach (instead of exposing `ipcRenderer.removeListener`
 * directly) keeps the contextBridge surface narrow: renderers can't
 * accidentally remove listeners they didn't install, and we can change
 * the channel name without touching renderer code.
 */
function subscribe<T extends unknown[]>(
	channel: string,
	listener: (...args: T) => void,
): () => void {
	const wrapped = (_event: Electron.IpcRendererEvent, ...args: T): void =>
		listener(...args);
	ipcRenderer.on(channel, wrapped);
	return () => {
		ipcRenderer.removeListener(channel, wrapped);
	};
}

const desktopApi = {
	platform: process.platform,

	openProjectWindow(projectId: string): void {
		ipcRenderer.send("open-project-window", projectId);
	},

	restartRuntime(): void {
		ipcRenderer.send("restart-runtime");
	},

	/**
	 * Fires when the background updater has finished installing a new
	 * runtime version into the user-side store and committed the
	 * pointer. The renderer should surface a "Restart to apply
	 * <version>" banner; clicking restart calls `restartRuntime()`,
	 * which spawns the new cli.js automatically (the resolver picks up
	 * the new pointer on the next spawn).
	 *
	 * Returns a detach function. Issue #438 §"Restart-to-apply".
	 */
	onUpdateStaged(listener: (version: string) => void): () => void {
		return subscribe<[string]>("runtime:update-staged", listener);
	},

	/**
	 * Fires when a just-promoted runtime failed its startup health
	 * probe and the orchestrator demoted it via `markCurrentBad`.
	 * Payload is the demoted version (or `null` if no version was
	 * recorded — e.g. a corrupted pointer). The renderer can surface a
	 * one-time toast: "Kanban runtime <v> didn't start; rolled back."
	 *
	 * Returns a detach function.
	 */
	onRuntimeRolledBack(
		listener: (demotedVersion: string | null) => void,
	): () => void {
		return subscribe<[string | null]>("runtime:rolled-back", listener);
	},

} as const;

contextBridge.exposeInMainWorld("desktop", desktopApi);

export type DesktopApi = typeof desktopApi;
