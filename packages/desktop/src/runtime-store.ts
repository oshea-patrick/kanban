/**
 * On-disk layout for the staged Kanban runtime under `${userData}/runtime-store/`:
 *
 *   current.json          — pointer { version, cliEntry }
 *   bad-versions.json     — versions to skip after a startup failure
 *   versions/<v>/         — finalized runtime
 *   versions/<v>.partial/ — in-flight extract; never read at boot
 *
 * The bundled runtime in `app.asar.unpacked/cli/` is the fallback —
 * if the pointer is missing or its spawn fails, we drop the pointer
 * and the shim launches bundled.
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

const POINTER_FILE = "current.json";
const BAD_VERSIONS_FILE = "bad-versions.json";

const root = (userData: string): string => path.join(userData, "runtime-store");
const pointerPath = (userData: string): string =>
	path.join(root(userData), POINTER_FILE);
const badVersionsPath = (userData: string): string =>
	path.join(root(userData), BAD_VERSIONS_FILE);

const isSemver = (v: unknown): v is string =>
	typeof v === "string" && semver.valid(v) !== null;

export function versionDir(userData: string, version: string): string {
	if (!isSemver(version)) {
		throw new Error(`runtime-store: invalid semver: ${version}`);
	}
	return path.join(root(userData), "versions", version);
}

export function partialDir(userData: string, version: string): string {
	return `${versionDir(userData, version)}.partial`;
}

export function cliEntryFor(userData: string, version: string): string {
	return path.join(versionDir(userData, version), "dist", "cli.js");
}

function atomicWrite(target: string, body: string): void {
	mkdirSync(path.dirname(target), { recursive: true });
	const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(tmp, body);
	renameSync(tmp, target);
}

/**
 * Pointer's `cliEntry` must be the canonical path for the pointer's
 * version. We pass `cliEntry` to the shim as `KANBAN_CLI_OVERRIDE`,
 * so a non-canonical or out-of-tree path would let a tampered
 * `current.json` execute arbitrary on-disk JS. Returns the canonical
 * absolute path so callers don't have to re-resolve.
 */
export function readPointer(userData: string): RuntimePointer | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(pointerPath(userData), "utf8"));
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object") return null;
	const { version, cliEntry } = parsed as Record<string, unknown>;
	if (!isSemver(version)) return null;
	if (typeof cliEntry !== "string" || cliEntry.length === 0) return null;
	const canonical = cliEntryFor(userData, version);
	if (path.resolve(cliEntry) !== canonical) return null;
	return { version, cliEntry: canonical };
}

export function writePointer(userData: string, p: RuntimePointer): void {
	if (!isSemver(p.version)) {
		throw new Error(`runtime-store: invalid semver: ${p.version}`);
	}
	const canonical = cliEntryFor(userData, p.version);
	if (path.resolve(p.cliEntry) !== canonical) {
		throw new Error(
			`runtime-store: cliEntry for ${p.version} must be ${canonical}, got ${p.cliEntry}`,
		);
	}
	atomicWrite(
		pointerPath(userData),
		`${JSON.stringify({ version: p.version, cliEntry: canonical })}\n`,
	);
}

export function clearPointer(userData: string): void {
	rmSync(pointerPath(userData), { force: true });
}

/** Pointer's cliEntry iff the file exists on disk. */
export function resolvePointerCliEntry(userData: string): string | null {
	const p = readPointer(userData);
	if (!p) return null;
	try {
		return statSync(p.cliEntry).isFile() ? p.cliEntry : null;
	} catch {
		return null;
	}
}

/** Sweep `<v>.partial/` left over from interrupted extracts. Best-effort. */
export function cleanupPartials(userData: string): void {
	const versions = path.join(root(userData), "versions");
	if (!existsSync(versions)) return;
	for (const e of readdirSync(versions, { withFileTypes: true })) {
		if (e.isDirectory() && e.name.endsWith(".partial")) {
			rmSync(path.join(versions, e.name), { recursive: true, force: true });
		}
	}
}

export function removeVersionDir(userData: string, version: string): void {
	if (!isSemver(version)) return;
	rmSync(versionDir(userData, version), { recursive: true, force: true });
}

// -----------------------------------------------------------------
// Bad-version markers — stop the updater from re-staging a version
// that already failed startup. Entries are never pruned; the registry
// only publishes monotonically increasing versions and we only ever
// check `isBadVersion(latest)`, so old entries are dead weight (a few
// bytes) but never re-examined. If the file ever needs trimming, do
// it lazily here against an `effectiveCurrentVersion` argument.
// -----------------------------------------------------------------

function readBadVersions(userData: string): string[] {
	try {
		const parsed = JSON.parse(readFileSync(badVersionsPath(userData), "utf8"));
		return Array.isArray(parsed) ? parsed.filter(isSemver) : [];
	} catch {
		return [];
	}
}

export function isBadVersion(userData: string, version: string): boolean {
	return isSemver(version) && readBadVersions(userData).includes(version);
}

export function markBadVersion(userData: string, version: string): void {
	if (!isSemver(version)) {
		throw new Error(`runtime-store: invalid semver: ${version}`);
	}
	const set = new Set(readBadVersions(userData));
	set.add(version);
	atomicWrite(
		badVersionsPath(userData),
		`${JSON.stringify([...set].sort(semver.compare))}\n`,
	);
}
