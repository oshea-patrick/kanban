/**
 * Wires runtime-store + runtime-update into the orchestrator's
 * `cliEntryOverride` callbacks and a 30s/30min background check
 * schedule. Packaged-only — returns `null` in dev so the orchestrator
 * just spawns the bundled cli.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import semver from "semver";

import {
	cleanupPartials,
	clearPointer,
	markBadVersion,
	pointerFileExists,
	readPointer,
	removeVersionDir,
	resolvePointerCliEntry,
	versionFromCliEntry,
} from "./runtime-store.js";
import { checkAndStageLatestRuntime } from "./runtime-update.js";

const FIRST_CHECK_DELAY_MS = 30_000;
const CHECK_INTERVAL_MS = 30 * 60_000;

export interface RuntimeAutoUpdate {
	resolveCliEntryOverride: () => string | null;
	/**
	 * `cliEntry` must be exactly the path returned by an earlier
	 * `resolveCliEntryOverride()` call — i.e. captured at spawn time
	 * by the orchestrator. We use it to roll back the version that
	 * actually ran, even if a concurrent background stage has since
	 * advanced the pointer to a newer version.
	 */
	onCliEntryOverrideFailed: (reason: string, cliEntry: string) => void;
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

	const dropPointer = (why: string): void => {
		console.warn(`[desktop] ${why} — clearing pointer.`);
		try {
			clearPointer(deps.userData);
		} catch (e) {
			warn("clearPointer", e);
		}
	};

	// Effective launch version is `max(pointer, bundled)`. A pointer
	// at-or-below bundled is stale (e.g. user upgraded the shell while
	// userData still pointed at an older staged runtime); without this
	// guard we'd keep launching the older runtime forever. Also
	// self-repairs pointers whose `cliEntry` no longer exists, and
	// removes invalid `current.json` files (corrupt JSON, non-canonical
	// path, non-absolute path) so they can't linger as renderer-visible
	// state forever.
	const loadOverride = (): string | null => {
		const pointer = readPointer(deps.userData);
		if (!pointer) {
			if (pointerFileExists(deps.userData)) {
				dropPointer("Invalid current.json");
			}
			return null;
		}
		if (semver.lte(pointer.version, bundledVersion)) {
			dropPointer(
				`Staged ${pointer.version} <= bundled ${bundledVersion}`,
			);
			return null;
		}
		const cli = resolvePointerCliEntry(deps.userData);
		if (cli) return cli;
		dropPointer("Staged cliEntry missing");
		return null;
	};

	// Rollback for the version that *actually ran* — derived from the
	// captured cliEntry, not from re-reading the pointer. The orchestrator
	// runs the readiness probe asynchronously after spawn; in the
	// meantime, a background `runCheck()` may have completed a successful
	// staging and replaced the pointer with a newer version. Rolling back
	// "whatever the pointer says now" would mark/remove the *new*
	// version that hasn't even been tried yet.
	const onFailed = (reason: string, cliEntry: string): void => {
		const failedVersion = versionFromCliEntry(cliEntry);
		const current = readPointer(deps.userData);
		const pointerStillFailed =
			current !== null && current.cliEntry === cliEntry;
		console.warn(
			`[desktop] Staged runtime failed (${reason})${
				failedVersion ? `; rolling back ${failedVersion}` : ""
			}${pointerStillFailed ? "" : " (pointer already advanced)"}.`,
		);
		if (failedVersion) {
			try {
				markBadVersion(deps.userData, failedVersion);
			} catch (e) {
				warn("markBadVersion", e);
			}
			try {
				removeVersionDir(deps.userData, failedVersion);
			} catch (e) {
				warn("removeVersionDir", e);
			}
		}
		// Only clear the pointer if it still references the failed
		// version. If a background stage already replaced it with a
		// newer version, that version is presumed-good until proven
		// otherwise — don't drop a healthy successor pointer because of
		// a probe failure on a now-orphaned older spawn.
		if (pointerStillFailed) {
			try {
				clearPointer(deps.userData);
			} catch (e) {
				warn("clearPointer", e);
			}
		}
		deps.broadcast("runtime:rolled-back", failedVersion ?? null);
	};

	const runCheck = async (): Promise<void> => {
		// Single-flight: a slow extract racing the periodic interval
		// would otherwise re-enter pacote.extract on the same partial.
		if (inFlight) return;
		inFlight = true;
		try {
			// Side effect: drops a stale-or-broken pointer so the
			// version gate below sees an accurate `max(pointer, bundled)`.
			loadOverride();
			const ptr = readPointer(deps.userData);
			const currentVersion =
				ptr && semver.gt(ptr.version, bundledVersion)
					? ptr.version
					: bundledVersion;
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
