/**
 * Periodic check + install + pointer-commit loop. Lives outside the
 * orchestrator on purpose: update timing is causally independent of
 * the spawn pipeline (the running runtime keeps using its current
 * cli.js until the user restarts).
 */

import * as pacote from "pacote";
import semver from "semver";
import { installRuntime, type RuntimeInstallerConfig } from "./runtime-installer.js";
import type { RuntimeStore } from "./runtime-store.js";

const PACKAGE_NAME = "kanban";
const FOUR_HOURS = 4 * 60 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 30 * 1000;

export interface RuntimeBackgroundUpdaterConfig {
	store: RuntimeStore;
	installerConfig: RuntimeInstallerConfig;
	getCurrentVersion: () => string;
	onStaged: (version: string) => void;
	/** Override for tests. Defaults to `pacote.manifest`. */
	manifestImpl?: typeof pacote.manifest;
	intervalMs?: number;
	firstCheckDelayMs?: number;
}

export interface RuntimeBackgroundUpdater {
	start(): void;
	stop(): void;
	dispose(): Promise<void>;
	/** Manual trigger; returns the in-flight promise if already running. */
	checkNow(): Promise<void>;
}

export function createRuntimeBackgroundUpdater(
	cfg: RuntimeBackgroundUpdaterConfig,
): RuntimeBackgroundUpdater {
	const manifestImpl = cfg.manifestImpl ?? pacote.manifest;
	const intervalMs = cfg.intervalMs ?? FOUR_HOURS;
	const firstDelay = cfg.firstCheckDelayMs ?? FIRST_CHECK_DELAY_MS;

	let timer: NodeJS.Timeout | null = null;
	let inFlight: Promise<void> | null = null;
	let stopped = false;
	// Short-circuits re-install on the next tick: getCurrentVersion()
	// still returns the pre-staged version (the runtime hasn't restarted),
	// so the checker would otherwise still see staged-version as "newer".
	let lastStaged: string | null = null;

	function schedule(delay: number) {
		if (stopped) return;
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => {
			timer = null;
			void tick();
		}, delay);
		timer.unref?.(); // a 4h timer shouldn't pin app.quit()
	}

	async function tick() {
		try {
			await checkNow();
		} catch (err) {
			console.error("[runtime-updater] tick swallowed exception:", err);
		}
		schedule(intervalMs);
	}

	function checkNow(): Promise<void> {
		if (inFlight) return inFlight;
		inFlight = runOnce().finally(() => {
			inFlight = null;
		});
		return inFlight;
	}

	async function runOnce(): Promise<void> {
		if (stopped) return;
		const current = cfg.getCurrentVersion();

		let manifest: { version: string };
		try {
			manifest = await manifestImpl(`${PACKAGE_NAME}@latest`);
		} catch (err) {
			console.warn(
				`[runtime-updater] check failed: ${(err as Error).message}`,
			);
			return;
		}

		const latest = manifest.version;
		if (!semver.gt(latest, current)) return;
		if (lastStaged === latest) return;

		try {
			const result = await installRuntime(cfg.installerConfig, latest);
			cfg.store.writePointer({
				version: result.version,
				installedAt: new Date().toISOString(),
				cliEntry: result.cliEntry,
			});
			lastStaged = result.version;
			console.log(`[runtime-updater] staged ${result.version} for restart`);
			cfg.onStaged(result.version);
		} catch (err) {
			console.warn(
				`[runtime-updater] install ${latest} failed: ${(err as Error).message}`,
			);
		}
	}

	return {
		start() {
			if (stopped) throw new Error("RuntimeBackgroundUpdater: disposed");
			schedule(firstDelay);
		},
		stop() {
			if (timer) clearTimeout(timer);
			timer = null;
		},
		async dispose() {
			stopped = true;
			if (timer) clearTimeout(timer);
			timer = null;
			if (inFlight) await inFlight.catch(() => {});
		},
		checkNow,
	};
}
