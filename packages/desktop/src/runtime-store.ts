/**
 * On-disk layout for downloaded Kanban runtimes under
 * `${userData}/runtime-store/`:
 *
 *   versions/<version>/        finalized, runnable runtime
 *   versions/<version>.partial/ in-progress install (atomic-rename target)
 *   versions/<version>.bad     marker: this version failed startup
 *   current.json               pointer to the active runtime
 *
 * Pointer is JSON (not a symlink) because Windows symlinks need elevation.
 * Bad-marker is a sibling file (not a field in `current.json`) so a corrupted
 * pointer can't strand a bad version as "current".
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import semver from "semver";

/** Path of cli.js relative to an extracted runtime tree. */
export const RUNTIME_CLI_ENTRY = "dist/cli.js";

const PARTIAL_SUFFIX = ".partial";
const BAD_SUFFIX = ".bad";

export interface RuntimePointer {
	version: string;
	installedAt: string;
	cliEntry: string;
}

export interface RuntimeStore {
	root: string;
	versionsDir: string;
	versionDir(version: string): string;
	partialDir(version: string): string;
	pointerPath: string;
	readPointer(): RuntimePointer | null;
	writePointer(pointer: RuntimePointer): void;
	markBad(version: string): void;
	isBad(version: string): boolean;
	listVersions(): string[];
	cleanupPartials(): void;
	finalize(version: string): void;
}

export function createRuntimeStore(rootDir: string): RuntimeStore {
	const versionsDir = path.join(rootDir, "versions");
	const pointerPath = path.join(rootDir, "current.json");
	const versionDir = (v: string) => path.join(versionsDir, v);
	const partialDir = (v: string) => path.join(versionsDir, `${v}${PARTIAL_SUFFIX}`);
	const badPath = (v: string) => path.join(versionsDir, `${v}${BAD_SUFFIX}`);
	const ensure = () => mkdirSync(versionsDir, { recursive: true });

	return {
		root: rootDir,
		versionsDir,
		versionDir,
		partialDir,
		pointerPath,

		readPointer() {
			if (!existsSync(pointerPath)) return null;
			let parsed: unknown;
			try {
				parsed = JSON.parse(readFileSync(pointerPath, "utf8"));
			} catch {
				return null;
			}
			if (!isValidPointer(parsed)) return null;
			if (!semver.valid(parsed.version)) return null;
			if (!existsSync(versionDir(parsed.version))) return null;
			return parsed;
		},

		writePointer(pointer) {
			ensure();
			const tmp = `${pointerPath}.tmp`;
			writeFileSync(tmp, `${JSON.stringify(pointer, null, 2)}\n`);
			renameSync(tmp, pointerPath); // atomic
		},

		markBad(version) {
			ensure();
			writeFileSync(badPath(version), "");
		},

		isBad(version) {
			return existsSync(badPath(version));
		},

		listVersions() {
			if (!existsSync(versionsDir)) return [];
			const names: string[] = [];
			for (const entry of readdirSync(versionsDir, { withFileTypes: true })) {
				if (!entry.isDirectory()) continue;
				if (entry.name.endsWith(PARTIAL_SUFFIX)) continue;
				if (!semver.valid(entry.name)) continue;
				names.push(entry.name);
			}
			return names.sort((a, b) => semver.rcompare(a, b));
		},

		cleanupPartials() {
			if (!existsSync(versionsDir)) return;
			for (const entry of readdirSync(versionsDir, { withFileTypes: true })) {
				if (!entry.isDirectory()) continue;
				if (!entry.name.endsWith(PARTIAL_SUFFIX)) continue;
				rmSync(path.join(versionsDir, entry.name), {
					recursive: true,
					force: true,
				});
			}
		},

		finalize(version) {
			const partial = partialDir(version);
			const final = versionDir(version);
			if (!existsSync(partial)) {
				throw new Error(`runtime-store: missing partial install at ${partial}`);
			}
			if (existsSync(final)) {
				rmSync(final, { recursive: true, force: true });
			}
			renameSync(partial, final);
		},
	};
}

function isValidPointer(value: unknown): value is RuntimePointer {
	if (typeof value !== "object" || value === null) return false;
	const o = value as Record<string, unknown>;
	return (
		typeof o.version === "string" &&
		typeof o.installedAt === "string" &&
		typeof o.cliEntry === "string" &&
		o.cliEntry.length > 0
	);
}
