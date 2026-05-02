/**
 * Stage the latest published `kanban` runtime under the user-data
 * runtime-store so the installed shell can run a newer runtime than
 * the one it was packaged with — without requiring a shell reinstall.
 *
 * Flow:
 *   1. Ask the npm registry for `kanban@latest` (pacote.manifest)
 *   2. Skip if the active version (or already-staged pointer) is up
 *      to date
 *   3. `pacote.extract` the tarball into `versions/<v>.partial/`
 *   4. Copy bundled `node-pty` into the partial — published `kanban`
 *      lists `node-pty` as a runtime dep, but a freshly-pacote-extracted
 *      tarball contains no `node_modules/`. Reusing the desktop's
 *      bundled `node-pty` (already-prebuilt for this Electron's ABI)
 *      avoids needing system `npm` at runtime
 *   5. Verify `dist/cli.js` exists in the partial
 *   6. Atomically rename partial → version dir
 *   7. Atomically write the pointer
 *
 * Failures at any step before step 7 leave the existing pointer
 * untouched. The bundled runtime remains the fallback.
 *
 * No EventEmitter, no lifecycle class, no discriminated union of
 * outcomes — callers get either a `{ stagedVersion }` on success or a
 * thrown `Error` on failure (logged + swallowed at the call site).
 */

import { existsSync } from "node:fs";
import { cp, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";

import pacote from "pacote";
import semver from "semver";

import {
	cleanupPartials,
	partialDir,
	readPointer,
	versionDir,
	writePointer,
} from "./runtime-store.js";

const PACKAGE_NAME = "kanban";

export interface CheckOptions {
	/** Electron `app.getPath("userData")`. */
	userData: string;
	/**
	 * Version string the shell would launch right now (staged pointer
	 * version, or bundled-runtime version if no pointer). Used as the
	 * lower bound for the npm comparison.
	 */
	currentVersion: string;
	/**
	 * Absolute path to `app.asar.unpacked/node_modules/`. We copy
	 * `node-pty/` from here into the staged runtime.
	 */
	nativeDepsSource: string;
}

export interface StageResult {
	stagedVersion: string;
}

export async function checkAndStageLatestRuntime(
	opts: CheckOptions,
): Promise<StageResult | null> {
	const manifest = await pacote.manifest(`${PACKAGE_NAME}@latest`);
	const latest = manifest.version;

	if (!semver.valid(latest)) {
		throw new Error(
			`runtime-update: registry returned non-semver version: ${String(latest)}`,
		);
	}

	// Already on (or past) latest — nothing to do.
	if (!semver.gt(latest, opts.currentVersion)) return null;

	// Pointer already targets this version — a previous tick staged
	// it; the shell will pick it up at next launch. Don't re-extract.
	const pointer = readPointer(opts.userData);
	if (pointer?.version === latest) return null;

	// Sweep stale partials from prior interrupted runs *before* we
	// extract — an existing `<v>.partial/` would otherwise collide.
	cleanupPartials(opts.userData);

	const stageDir = partialDir(opts.userData, latest);
	await rm(stageDir, { recursive: true, force: true });
	await mkdir(path.dirname(stageDir), { recursive: true });

	// pacote.extract creates `stageDir` and writes the package
	// contents into it. It refuses to overwrite a non-empty target,
	// hence the `rm` above.
	await pacote.extract(`${PACKAGE_NAME}@${latest}`, stageDir);

	// Native deps: copy from the desktop's bundled
	// `app.asar.unpacked/node_modules/`. The published kanban tarball
	// declares `node-pty` as a dep but pacote does not install deps —
	// only extracts the package itself. Using the bundled prebuilt
	// guarantees ABI compatibility with the running Electron without
	// requiring system `npm`.
	const ptySrc = path.join(opts.nativeDepsSource, "node-pty");
	if (!existsSync(ptySrc)) {
		throw new Error(`runtime-update: bundled node-pty not found at ${ptySrc}`);
	}
	await cp(ptySrc, path.join(stageDir, "node_modules", "node-pty"), {
		recursive: true,
		dereference: true,
	});

	// Verify the entry point we'd point at actually exists, before we
	// commit. A missing `dist/cli.js` here would brick the next boot.
	const cliEntry = path.join(stageDir, "dist", "cli.js");
	if (!existsSync(cliEntry)) {
		throw new Error(
			`runtime-update: extracted package missing dist/cli.js (got ${cliEntry})`,
		);
	}

	// Atomically promote partial → version dir. If a prior run already
	// left a finalized `<v>/` somewhere — unlikely, since the version
	// gate above would have skipped — clear it first.
	const finalDir = versionDir(opts.userData, latest);
	await rm(finalDir, { recursive: true, force: true });
	await rename(stageDir, finalDir);

	// Atomic pointer write. Until this returns, every prior failure
	// path has left the pointer untouched.
	writePointer(opts.userData, {
		version: latest,
		cliEntry: path.join(finalDir, "dist", "cli.js"),
	});

	return { stagedVersion: latest };
}
