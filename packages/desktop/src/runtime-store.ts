/**
 * On-disk layout for the staged Kanban runtime that lives next to the
 * installed shell's user data. Intentionally minimal:
 *
 *   <userData>/runtime-store/
 *     current.json                 — pointer { version, cliEntry }
 *     versions/<v>/                — finalized runtime (extract output)
 *     versions/<v>.partial/        — in-flight extract; never read at boot
 *
 * No multi-version fallback list, no bad-marker subsystem, no retention
 * policy. The bundled runtime in `app.asar.unpacked/cli/` is THE
 * fallback — if the staged runtime is missing or its spawn fails, the
 * shell drops the pointer and falls back to bundled.
 */

import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";

export interface RuntimePointer {
	version: string;
	/** Absolute path to the `dist/cli.js` of the staged runtime. */
	cliEntry: string;
}

const POINTER_FILENAME = "current.json";
const VERSIONS_DIRNAME = "versions";

// Conservative semver-segment guard. Pacote will refuse anything wilder
// upstream, but we accept user-data input here, so be paranoid.
const SAFE_VERSION_RE = /^[0-9A-Za-z.\-+]+$/;

function rootDir(userData: string): string {
	return path.join(userData, "runtime-store");
}

function pointerPath(userData: string): string {
	return path.join(rootDir(userData), POINTER_FILENAME);
}

function isSafeVersion(v: unknown): v is string {
	return (
		typeof v === "string" &&
		v.length > 0 &&
		v !== "." &&
		v !== ".." &&
		SAFE_VERSION_RE.test(v)
	);
}

function isInsideStore(userData: string, candidate: string): boolean {
	const root = rootDir(userData);
	const resolved = path.resolve(candidate);
	// `path.resolve` collapses `..` segments, so a value of
	// "<store>/versions/../../../etc/passwd" is normalized before the
	// prefix test. The trailing separator prevents
	// "/var/store-evil" from matching "/var/store" via prefix.
	return resolved === root || resolved.startsWith(root + path.sep);
}

export function versionDir(userData: string, version: string): string {
	if (!isSafeVersion(version)) {
		throw new Error(`runtime-store: unsafe version segment: ${version}`);
	}
	return path.join(rootDir(userData), VERSIONS_DIRNAME, version);
}

export function partialDir(userData: string, version: string): string {
	return `${versionDir(userData, version)}.partial`;
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
	if (!isInsideStore(userData, cliEntry)) return null;

	return { version, cliEntry: path.resolve(cliEntry) };
}

export function writePointer(userData: string, pointer: RuntimePointer): void {
	if (!isSafeVersion(pointer.version)) {
		throw new Error(`runtime-store: unsafe version: ${pointer.version}`);
	}
	if (!isInsideStore(userData, pointer.cliEntry)) {
		throw new Error(
			`runtime-store: cliEntry must live inside ${rootDir(userData)}: ${pointer.cliEntry}`,
		);
	}

	mkdirSync(rootDir(userData), { recursive: true });
	const target = pointerPath(userData);
	const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(
		tmp,
		`${JSON.stringify({
			version: pointer.version,
			cliEntry: path.resolve(pointer.cliEntry),
		})}\n`,
	);
	// Atomic on POSIX; on Win32 fs.renameSync overwrites.
	renameSync(tmp, target);
}

export function clearPointer(userData: string): void {
	rmSync(pointerPath(userData), { force: true });
}

/**
 * Sweep any leftover `<v>.partial/` directories from prior interrupted
 * extracts. Safe to call on every boot — it never touches finalized
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
