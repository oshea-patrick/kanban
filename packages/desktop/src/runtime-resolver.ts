/**
 * Boot-time runtime selection. Resolution order:
 *   1. Pointer version, if its tree+cli.js exist and it isn't bad-marked.
 *   2. Most-recent good (non-bad) installed version.
 *   3. Bundled cli.js shipped with the desktop app (last resort).
 *
 * Pure synchronous decision module — no I/O beyond `existsSync`/`statSync`.
 */

import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { RUNTIME_CLI_ENTRY, type RuntimeStore } from "./runtime-store.js";

export type RuntimeSource = "pointer" | "fallback-version" | "bundled";

export interface ResolvedRuntime {
	source: RuntimeSource;
	/** Resolved runtime version. Null only when bundled and no version was supplied. */
	version: string | null;
	cliEntryAbsolutePath: string;
	/** What `current.json` says (regardless of which arm we returned). */
	pointerVersion: string | null;
}

export interface RuntimeResolverConfig {
	store: RuntimeStore;
	/** Absolute path to the desktop's bundled cli.js — the last-resort fallback. */
	bundledCliEntry: string;
	bundledVersion: string | null;
}

export function resolveRuntime(cfg: RuntimeResolverConfig): ResolvedRuntime {
	const { store, bundledCliEntry, bundledVersion } = cfg;
	const pointer = store.readPointer();
	const pointerVersion = pointer?.version ?? null;

	if (pointer && isHealthy(store, pointer.version, pointer.cliEntry)) {
		return {
			source: "pointer",
			version: pointer.version,
			cliEntryAbsolutePath: path.join(
				store.versionDir(pointer.version),
				pointer.cliEntry,
			),
			pointerVersion,
		};
	}

	// Fallback arm: highest-semver healthy version that isn't the broken pointer.
	for (const v of store.listVersions()) {
		if (v === pointerVersion) continue;
		if (isHealthy(store, v, RUNTIME_CLI_ENTRY)) {
			return {
				source: "fallback-version",
				version: v,
				cliEntryAbsolutePath: path.join(store.versionDir(v), RUNTIME_CLI_ENTRY),
				pointerVersion,
			};
		}
	}

	if (!existsSync(bundledCliEntry)) {
		throw new Error(
			`runtime-resolver: bundled cli.js missing at ${bundledCliEntry}; nothing left to fall back to`,
		);
	}
	return {
		source: "bundled",
		version: bundledVersion,
		cliEntryAbsolutePath: bundledCliEntry,
		pointerVersion,
	};
}

function isHealthy(
	store: RuntimeStore,
	version: string,
	cliEntryRelative: string,
): boolean {
	if (store.isBad(version)) return false;
	const dir = store.versionDir(version);
	if (!existsSync(dir)) return false;
	try {
		if (!statSync(dir).isDirectory()) return false;
		const cli = path.join(dir, cliEntryRelative);
		return existsSync(cli) && statSync(cli).isFile();
	} catch {
		return false;
	}
}
