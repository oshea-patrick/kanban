/**
 * Wires runtime-store + runtime-update into the orchestrator's
 * `cliEntryOverride` callbacks and a 30s/30min background check
 * schedule. Packaged-only — returns `null` in dev so the orchestrator
 * just spawns the bundled cli.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import {
	cleanupPartials,
	clearPointer,
	markBadVersion,
	readPointer,
	removeVersionDir,
	resolvePointerCliEntry,
} from "./runtime-store.js";
import { checkAndStageLatestRuntime } from "./runtime-update.js";

const FIRST_CHECK_DELAY_MS = 30_000;
const CHECK_INTERVAL_MS = 30 * 60_000;

export interface RuntimeAutoUpdate {
	resolveCliEntryOverride: () => string | null;
	onCliEntryOverrideFailed: (reason: string) => void;
	scheduleChecks(): void;
	stop(): void;
}

export interface RuntimeAutoUpdateDeps {
	isPackaged: boolean;
	userData: string;
	resourcesPath: string;
	shellVersion: string;
	broadcast: (channel: string, ...args: unknown[]) => void;
}

export function createRuntimeAutoUpdate(
	deps: RuntimeAutoUpdateDeps,
): RuntimeAutoUpdate | null {
	if (!deps.isPackaged) return null;

	const unpacked = path.join(deps.resourcesPath, "app.asar.unpacked");
	const bundledVersion =
		readBundledVersion(path.join(unpacked, "cli")) ?? deps.shellVersion;
	// `node-pty` lives under `app.asar.unpacked/node_modules/` after
	// `electron-builder install-app-deps` rebuilds it for this Electron.
	const nativeDepsSource = path.join(unpacked, "node_modules");

	// Sweep stale `<v>.partial/` from interrupted extracts before any
	// new staging can collide with them.
	try {
		cleanupPartials(deps.userData);
	} catch (e) {
		warn("cleanupPartials", e);
	}

	let firstTimer: NodeJS.Timeout | null = null;
	let interval: NodeJS.Timeout | null = null;
	let inFlight = false;

	// Self-repair: a pointer whose `cliEntry` no longer exists on disk
	// (user wiped userData, aborted update, etc.) gets dropped here.
	// Without this, the version gate would forever read the stale
	// pointer's version as `currentVersion` and skip new versions.
	const loadOverride = (): string | null => {
		const cli = resolvePointerCliEntry(deps.userData);
		if (cli) return cli;
		if (readPointer(deps.userData)) {
			console.warn("[desktop] Staged cliEntry missing — clearing pointer.");
			try {
				clearPointer(deps.userData);
			} catch (e) {
				warn("clearPointer", e);
			}
		}
		return null;
	};

	const onFailed = (reason: string): void => {
		const failed = readPointer(deps.userData);
		console.warn(
			`[desktop] Staged runtime failed (${reason})${
				failed ? `; rolling back ${failed.version}` : ""
			}.`,
		);
		if (failed) {
			try {
				markBadVersion(deps.userData, failed.version);
			} catch (e) {
				warn("markBadVersion", e);
			}
			try {
				removeVersionDir(deps.userData, failed.version);
			} catch (e) {
				warn("removeVersionDir", e);
			}
		}
		try {
			clearPointer(deps.userData);
		} catch (e) {
			warn("clearPointer", e);
		}
		deps.broadcast("runtime:rolled-back", failed?.version ?? null);
	};

	const runCheck = async (): Promise<void> => {
		// Single-flight: a slow extract racing the periodic interval
		// would otherwise re-enter pacote.extract on the same partial.
		if (inFlight) return;
		inFlight = true;
		try {
			const currentVersion =
				loadOverride() === null
					? bundledVersion
					: (readPointer(deps.userData)?.version ?? bundledVersion);
			const outcome = await checkAndStageLatestRuntime({
				userData: deps.userData,
				currentVersion,
				nativeDepsSource,
			});
			if (outcome.kind === "staged") {
				console.log(
					`[desktop] Staged kanban@${outcome.version} — restart to apply.`,
				);
				deps.broadcast("runtime:update-staged", outcome.version);
			} else if (outcome.kind === "bad-version") {
				console.log(
					`[desktop] Skipping kanban@${outcome.version}: previously failed startup.`,
				);
			}
		} catch (e) {
			console.warn(
				"[desktop] Runtime update check failed:",
				e instanceof Error ? e.message : e,
			);
		} finally {
			inFlight = false;
		}
	};

	return {
		resolveCliEntryOverride: loadOverride,
		onCliEntryOverrideFailed: onFailed,
		scheduleChecks() {
			firstTimer = setTimeout(() => void runCheck(), FIRST_CHECK_DELAY_MS);
			firstTimer.unref();
			interval = setInterval(() => void runCheck(), CHECK_INTERVAL_MS);
			interval.unref();
		},
		stop() {
			if (firstTimer) {
				clearTimeout(firstTimer);
				firstTimer = null;
			}
			if (interval) {
				clearInterval(interval);
				interval = null;
			}
		},
	};
}

function readBundledVersion(cliDir: string): string | null {
	try {
		const parsed = JSON.parse(
			readFileSync(path.join(cliDir, "package.json"), "utf8"),
		) as { version?: unknown };
		return typeof parsed.version === "string" ? parsed.version : null;
	} catch {
		return null;
	}
}

function warn(label: string, err: unknown): void {
	console.warn(
		`[desktop] ${label} failed:`,
		err instanceof Error ? err.message : err,
	);
}
