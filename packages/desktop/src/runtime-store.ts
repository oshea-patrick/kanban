/**
 * On-disk layout for the staged Kanban runtime that lives next to the
 * installed shell's user data. Intentionally minimal:
 *
 *   <userData>/runtime-store/
 *     current.json                 — pointer { version, cliEntry }
 *     bad-versions.json            — small list of versions to skip
 *     versions/<v>/                — finalized runtime (extract output)
 *     versions/<v>.partial/        — in-flight extract; never read at boot
 *
 * No multi-version fallback list, no retention policy. The bundled
 * runtime in `app.asar.unpacked/cli/` is THE fallback — if the staged
 * runtime is missing or its spawn fails, the shell drops the pointer
 * and falls back to bundled.
 *
 * `bad-versions.json` exists for one job: stop the background updater
 * from re-staging the *exact* version that just failed startup. Without
 * it, a `kanban@latest` that's incompatible with this shell (e.g. a
 * runtime whose engines outgrew the bundled Electron node) would
 * re-stage every 30 minutes, prompt the user every 30 minutes, fail
 * every restart. The list is tiny on purpose: the next semver bump from
 * upstream supersedes any failed entry as soon as `latest > failed`,
 * so it self-empties.
 */

import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";

import semver from "semver";

export interface RuntimePointer {
	version: string;
	/** Absolute path to `versions/<version>/dist/cli.js`. */
	cliEntry: string;
}

const POINTER_FILENAME = "current.json";
const BAD_VERSIONS_FILENAME = "bad-versions.json";
const VERSIONS_DIRNAME = "versions";
const CLI_ENTRY_REL = path.join("dist", "cli.js");

function rootDir(userData: string): string {
	return path.join(userData, "runtime-store");
}

function pointerPath(userData: string): string {
	return path.join(rootDir(userData), POINTER_FILENAME);
}

function badVersionsPath(userData: string): string {
	return path.join(rootDir(userData), BAD_VERSIONS_FILENAME);
}

function isSafeVersion(v: unknown): v is string {
	// Strict semver: pacote and our updater both compare via `semver`,
	// so a non-semver pointer value would either bypass the version
	// gate (`semver.gt` throws/returns false) or get re-staged forever.
	// Pinning to `semver.valid(...)` keeps the contract honest.
	return typeof v === "string" && semver.valid(v) !== null;
}

export function versionDir(userData: string, version: string): string {
	if (!isSafeVersion(version)) {
		throw new Error(`runtime-store: not a valid semver: ${version}`);
	}
	return path.join(rootDir(userData), VERSIONS_DIRNAME, version);
}

export function partialDir(userData: string, version: string): string {
	return `${versionDir(userData, version)}.partial`;
}

/**
 * Canonical cliEntry path for a given version. Both reader and writer
 * pin to this so a hand-edited or stale pointer pointing somewhere else
 * inside the store (an earlier layout, a typo) is rejected.
 */
function expectedCliEntry(userData: string, version: string): string {
	return path.join(versionDir(userData, version), CLI_ENTRY_REL);
}

export function readPointer(userData: string): RuntimePointer | null {
	const file = pointerPath(userData);
	if (!existsSync(file)) return null;

	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;

	const { version, cliEntry } = parsed as Record<string, unknown>;
	if (!isSafeVersion(version)) return null;
	if (typeof cliEntry !== "string" || cliEntry.length === 0) return null;

	// cliEntry must be exactly `versionDir/<v>/dist/cli.js`. Anything
	// else — a path under the store but not at the canonical location,
	// a path outside the store, a path-traversal payload — is rejected.
	const resolved = path.resolve(cliEntry);
	if (resolved !== expectedCliEntry(userData, version)) return null;

	return { version, cliEntry: resolved };
}

export function writePointer(userData: string, pointer: RuntimePointer): void {
	if (!isSafeVersion(pointer.version)) {
		throw new Error(`runtime-store: not a valid semver: ${pointer.version}`);
	}
	const expected = expectedCliEntry(userData, pointer.version);
	if (path.resolve(pointer.cliEntry) !== expected) {
		throw new Error(
			`runtime-store: cliEntry must be ${expected}, got ${pointer.cliEntry}`,
		);
	}

	mkdirSync(rootDir(userData), { recursive: true });
	const target = pointerPath(userData);
	const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(
		tmp,
		`${JSON.stringify({ version: pointer.version, cliEntry: expected })}\n`,
	);
	// Atomic on POSIX; on Win32 fs.renameSync overwrites.
	renameSync(tmp, target);
}

export function clearPointer(userData: string): void {
	rmSync(pointerPath(userData), { force: true });
}

/**
 * Sweep any leftover `<v>.partial/` directories from prior interrupted
 * extracts. Safe to call on every boot — never touches finalized
 * `<v>/` dirs or the pointer.
 */
export function cleanupPartials(userData: string): void {
	const versionsRoot = path.join(rootDir(userData), VERSIONS_DIRNAME);
	if (!existsSync(versionsRoot)) return;
	for (const entry of readdirSync(versionsRoot, { withFileTypes: true })) {
		if (entry.isDirectory() && entry.name.endsWith(".partial")) {
			rmSync(path.join(versionsRoot, entry.name), {
				recursive: true,
				force: true,
			});
		}
	}
}

// -----------------------------------------------------------------
// Bad-version markers
// -----------------------------------------------------------------

function readBadVersionsRaw(userData: string): string[] {
	const file = badVersionsPath(userData);
	if (!existsSync(file)) return [];
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8"));
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((v): v is string => isSafeVersion(v));
	} catch {
		return [];
	}
}

function writeBadVersionsRaw(userData: string, versions: string[]): void {
	mkdirSync(rootDir(userData), { recursive: true });
	const target = badVersionsPath(userData);
	const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(versions)}\n`);
	renameSync(tmp, target);
}

export function isBadVersion(userData: string, version: string): boolean {
	if (!isSafeVersion(version)) return false;
	return readBadVersionsRaw(userData).includes(version);
}

/**
 * Persist `version` as known-bad so the background updater stops trying
 * to stage it. No-op if already marked. Caller is responsible for also
 * removing any on-disk version dir + clearing the pointer.
 *
 * The list also gets garbage-collected on write: any entry that's now
 * `<= bundledVersion` can never be staged again anyway (the updater
 * compares against `max(pointer, bundled)`), so we drop it. This keeps
 * the file from accumulating stale entries indefinitely.
 */
export function markBadVersion(
	userData: string,
	version: string,
	bundledVersion?: string,
): void {
	if (!isSafeVersion(version)) {
		throw new Error(`runtime-store: not a valid semver: ${version}`);
	}
	const existing = new Set(readBadVersionsRaw(userData));
	existing.add(version);
	const pruned = bundledVersion
		? Array.from(existing).filter((v) => semver.gt(v, bundledVersion))
		: Array.from(existing);
	pruned.sort(semver.compare);
	writeBadVersionsRaw(userData, pruned);
}

export function listBadVersions(userData: string): string[] {
	return readBadVersionsRaw(userData);
}

/**
 * Delete a finalized `<v>/` dir from the store. Used after marking a
 * version bad — there's no point keeping a runtime we'll never launch.
 * Safe to call when the dir doesn't exist.
 */
export function removeVersionDir(userData: string, version: string): void {
	if (!isSafeVersion(version)) return;
	const dir = versionDir(userData, version);
	rmSync(dir, { recursive: true, force: true });
}

/**
 * Resolve a pointer's `cliEntry` if and only if the file actually
 * exists on disk. Returns `null` for missing pointer, missing file, or
 * any I/O error. The caller (main.ts) clears the pointer on `null` so
 * a corrupted store self-repairs on next launch instead of silently
 * suppressing the background updater.
 */
export function resolvePointerCliEntry(userData: string): string | null {
	const pointer = readPointer(userData);
	if (!pointer) return null;
	try {
		if (!statSync(pointer.cliEntry).isFile()) return null;
	} catch {
		return null;
	}
	return pointer.cliEntry;
}
