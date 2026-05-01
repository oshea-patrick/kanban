/**
 * Downloads + verifies + extracts the `kanban` runtime via `pacote.extract`,
 * stages the desktop's already-rebuilt-against-Electron-ABI native deps
 * (node-pty) into the extracted tree, then atomically promotes the partial
 * install via `store.finalize()`. Pacote handles fetch / SRI / shasum /
 * tar-strict-mode internally.
 */

import { existsSync } from "node:fs";
import { cp, mkdir } from "node:fs/promises";
import path from "node:path";
import * as pacote from "pacote";
import { RUNTIME_CLI_ENTRY, type RuntimeStore } from "./runtime-store.js";

const PACKAGE_NAME = "kanban";
const NATIVE_DEPS = ["node-pty"];
const FETCH_TIMEOUT_MS = 60_000;

export interface InstallResult {
	version: string;
	cliEntry: string;
}

export interface RuntimeInstallerConfig {
	store: RuntimeStore;
	/**
	 * Directory we copy native deps from. In packaged builds this is
	 * `app.asar.unpacked/node_modules`, where `electron-builder
	 * install-app-deps` has rebuilt node-pty against the bundled
	 * Electron ABI. Pass `null` to skip native staging (tests only).
	 */
	nativeDepsSource: string | null;
	/** Override for tests. Defaults to `pacote.extract`. */
	extractImpl?: typeof pacote.extract;
}

export async function installRuntime(
	cfg: RuntimeInstallerConfig,
	version: string,
): Promise<InstallResult> {
	const { store, nativeDepsSource } = cfg;
	const extractImpl = cfg.extractImpl ?? pacote.extract;

	// Defensive sweep — orchestrator's boot janitor also runs this, but a
	// fresh install after a previous crashed install would otherwise
	// collide with a stale partial dir.
	store.cleanupPartials();

	const partial = store.partialDir(version);
	await mkdir(partial, { recursive: true });

	// pacote: fetch + SRI/shasum verify + tar-strict extract, refuses
	// extraction outside `partial`. Strips the `package/` prefix, so
	// `<partial>/dist/cli.js` is the extracted entry.
	await extractImpl(`${PACKAGE_NAME}@${version}`, partial, {
		fetchRetries: 0,
		timeout: FETCH_TIMEOUT_MS,
	});

	if (nativeDepsSource !== null) {
		const targetNm = path.join(partial, "node_modules");
		await mkdir(targetNm, { recursive: true });
		for (const dep of NATIVE_DEPS) {
			const src = path.join(nativeDepsSource, dep);
			if (!existsSync(src)) {
				throw new Error(
					`runtime-installer: native dep '${dep}' not found at ${src}`,
				);
			}
			// `dereference: true` materialises symlinks so the staged copy
			// survives the desktop's own node_modules moving on app update.
			await cp(src, path.join(targetNm, dep), {
				recursive: true,
				dereference: true,
			});
		}
	}

	if (!existsSync(path.join(partial, RUNTIME_CLI_ENTRY))) {
		throw new Error(
			`runtime-installer: extracted tree missing ${RUNTIME_CLI_ENTRY}`,
		);
	}

	store.finalize(version);
	return { version, cliEntry: RUNTIME_CLI_ENTRY };
}
