import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	cleanupPartials,
	clearPointer,
	isBadVersion,
	listBadVersions,
	markBadVersion,
	partialDir,
	readPointer,
	removeVersionDir,
	resolvePointerCliEntry,
	versionDir,
	writePointer,
} from "../src/runtime-store.js";

let userData: string;

beforeEach(() => {
	userData = mkdtempSync(path.join(tmpdir(), "runtime-store-"));
});

afterEach(() => {
	rmSync(userData, { recursive: true, force: true });
});

const pointerPathFor = (root: string): string =>
	path.join(root, "runtime-store", "current.json");

/** Lay out `versions/<v>/dist/cli.js` so a pointer to it is valid. */
function stageVersion(root: string, version: string): string {
	const cliEntry = path.join(versionDir(root, version), "dist", "cli.js");
	mkdirSync(path.dirname(cliEntry), { recursive: true });
	writeFileSync(cliEntry, "// runtime");
	return cliEntry;
}

describe("runtime-store: pointer", () => {
	it("returns null when missing", () => {
		expect(readPointer(userData)).toBeNull();
	});

	it("returns null when the file is corrupt JSON", () => {
		mkdirSync(path.dirname(pointerPathFor(userData)), { recursive: true });
		writeFileSync(pointerPathFor(userData), "{not-json");
		expect(readPointer(userData)).toBeNull();
	});

	it("round-trips a pointer atomically (writes via tmp + rename, no leftover *.tmp)", () => {
		const cliEntry = stageVersion(userData, "0.1.66");
		writePointer(userData, { version: "0.1.66", cliEntry });

		const dir = path.dirname(pointerPathFor(userData));
		expect(readdirSync(dir).some((n) => n.endsWith(".tmp"))).toBe(false);
		expect(readPointer(userData)).toEqual({
			version: "0.1.66",
			cliEntry: path.resolve(cliEntry),
		});
	});

	describe("validation", () => {
		// All of these reach the on-disk pointer via a hand-written file
		// (not writePointer) because writePointer enforces the same
		// invariants up front. The whole point is that even a corrupted /
		// hand-edited / cross-version pointer must not leak out of
		// readPointer().
		const writeRawPointer = (root: string, body: unknown): void => {
			mkdirSync(path.dirname(pointerPathFor(root)), { recursive: true });
			writeFileSync(pointerPathFor(root), JSON.stringify(body));
		};

		it("rejects non-semver version strings (defends downstream semver.gt)", () => {
			writeRawPointer(userData, {
				version: "abc",
				cliEntry: path.join(versionDir(userData, "0.1.0"), "dist", "cli.js"),
			});
			expect(readPointer(userData)).toBeNull();
		});

		it("rejects path-traversal version strings", () => {
			writeRawPointer(userData, {
				version: "../../../etc/passwd",
				cliEntry: "/x",
			});
			expect(readPointer(userData)).toBeNull();
		});

		it("rejects cliEntry pointing outside the runtime-store root", () => {
			writeRawPointer(userData, { version: "1.0.0", cliEntry: "/etc/passwd" });
			expect(readPointer(userData)).toBeNull();
		});

		it("rejects cliEntry under the store but not at versionDir/dist/cli.js (shape mismatch)", () => {
			// Lives under runtime-store/ but at the wrong relative path.
			// A previous version of the layout — or a hand-edit — would
			// otherwise sneak through.
			const wrongShape = path.join(
				versionDir(userData, "1.0.0"),
				"dist",
				"index.js",
			);
			mkdirSync(path.dirname(wrongShape), { recursive: true });
			writeFileSync(wrongShape, "// not cli.js");
			writeRawPointer(userData, { version: "1.0.0", cliEntry: wrongShape });
			expect(readPointer(userData)).toBeNull();
		});

		it("rejects cliEntry whose embedded version segment doesn't match `version`", () => {
			// `version: "1.0.0"` but cliEntry points into `versions/2.0.0/`.
			// `path.resolve` won't normalize this away, and the strict
			// equality check catches it.
			const mismatched = path.join(
				versionDir(userData, "2.0.0"),
				"dist",
				"cli.js",
			);
			mkdirSync(path.dirname(mismatched), { recursive: true });
			writeFileSync(mismatched, "// runtime");
			writeRawPointer(userData, { version: "1.0.0", cliEntry: mismatched });
			expect(readPointer(userData)).toBeNull();
		});
	});

	it("writePointer rejects a non-semver version up front", () => {
		expect(() =>
			writePointer(userData, {
				version: "abc",
				cliEntry: path.join(versionDir(userData, "0.1.0"), "dist", "cli.js"),
			}),
		).toThrow(/not a valid semver/);
	});

	it("writePointer rejects a cliEntry that doesn't match the canonical shape", () => {
		expect(() =>
			writePointer(userData, {
				version: "1.0.0",
				cliEntry: "/etc/passwd",
			}),
		).toThrow(/cliEntry must be/);
	});

	it("clearPointer is a no-op when missing and removes when present", () => {
		expect(() => clearPointer(userData)).not.toThrow();
		const cliEntry = stageVersion(userData, "0.1.0");
		writePointer(userData, { version: "0.1.0", cliEntry });
		clearPointer(userData);
		expect(readPointer(userData)).toBeNull();
	});
});

describe("runtime-store: resolvePointerCliEntry", () => {
	it("returns null when no pointer exists", () => {
		expect(resolvePointerCliEntry(userData)).toBeNull();
	});

	it("returns the cliEntry when it exists on disk", () => {
		const cliEntry = stageVersion(userData, "0.5.0");
		writePointer(userData, { version: "0.5.0", cliEntry });
		expect(resolvePointerCliEntry(userData)).toBe(path.resolve(cliEntry));
	});

	it("returns null when pointer exists but cliEntry is missing on disk", () => {
		// The blocker case: pointer claims a version that's no longer
		// staged. Caller (`loadStagedCliOverride` in main.ts) uses this
		// to drop the pointer and unfreeze the background updater.
		const cliEntry = stageVersion(userData, "0.6.0");
		writePointer(userData, { version: "0.6.0", cliEntry });
		rmSync(path.dirname(cliEntry), { recursive: true });
		expect(resolvePointerCliEntry(userData)).toBeNull();
	});

	it("returns null when cliEntry points at a directory rather than a file", () => {
		const cliEntry = stageVersion(userData, "0.7.0");
		writePointer(userData, { version: "0.7.0", cliEntry });
		// Replace the file with a directory of the same name.
		rmSync(cliEntry, { force: true });
		mkdirSync(cliEntry, { recursive: true });
		expect(resolvePointerCliEntry(userData)).toBeNull();
	});
});

describe("runtime-store: bad-versions list", () => {
	it("isBadVersion is false for every version when the file is missing", () => {
		expect(isBadVersion(userData, "1.0.0")).toBe(false);
		expect(listBadVersions(userData)).toEqual([]);
	});

	it("markBadVersion persists the version and isBadVersion reads it back", () => {
		markBadVersion(userData, "1.2.3");
		expect(isBadVersion(userData, "1.2.3")).toBe(true);
		expect(isBadVersion(userData, "1.2.4")).toBe(false);
	});

	it("markBadVersion is idempotent (no duplicate entries)", () => {
		markBadVersion(userData, "1.2.3");
		markBadVersion(userData, "1.2.3");
		markBadVersion(userData, "1.2.3");
		expect(listBadVersions(userData)).toEqual(["1.2.3"]);
	});

	it("markBadVersion sorts entries by semver", () => {
		markBadVersion(userData, "1.10.0");
		markBadVersion(userData, "1.2.0");
		markBadVersion(userData, "1.9.0");
		expect(listBadVersions(userData)).toEqual(["1.2.0", "1.9.0", "1.10.0"]);
	});

	it("markBadVersion(version, bundledVersion) prunes entries no longer reachable", () => {
		// Once the bundled runtime moves past a previously-failed
		// version, that entry can never be staged again (the version
		// gate compares against `max(pointer, bundled)`), so we drop it
		// to keep the file from accumulating forever.
		markBadVersion(userData, "0.5.0");
		markBadVersion(userData, "0.7.0");
		markBadVersion(userData, "1.0.0", "0.8.0");
		expect(listBadVersions(userData)).toEqual(["1.0.0"]);
	});

	it("rejects non-semver versions on write", () => {
		expect(() => markBadVersion(userData, "not-a-version")).toThrow(
			/not a valid semver/,
		);
	});

	it("filters non-semver entries on read (file corruption defense)", () => {
		mkdirSync(path.join(userData, "runtime-store"), { recursive: true });
		writeFileSync(
			path.join(userData, "runtime-store", "bad-versions.json"),
			JSON.stringify(["1.0.0", "junk", "../../../etc/passwd", "2.0.0"]),
		);
		expect(listBadVersions(userData)).toEqual(["1.0.0", "2.0.0"]);
	});

	it("ignores a corrupt bad-versions.json (returns []), does not throw", () => {
		mkdirSync(path.join(userData, "runtime-store"), { recursive: true });
		writeFileSync(
			path.join(userData, "runtime-store", "bad-versions.json"),
			"{not-json",
		);
		expect(listBadVersions(userData)).toEqual([]);
		expect(isBadVersion(userData, "1.0.0")).toBe(false);
	});

	it("writes atomically (no leftover *.tmp siblings)", () => {
		markBadVersion(userData, "1.2.3");
		const dir = path.join(userData, "runtime-store");
		expect(readdirSync(dir).some((n) => n.endsWith(".tmp"))).toBe(false);

		// And the on-disk file is parseable + canonical.
		const raw = readFileSync(
			path.join(dir, "bad-versions.json"),
			"utf8",
		);
		expect(JSON.parse(raw)).toEqual(["1.2.3"]);
	});
});

describe("runtime-store: cleanupPartials / removeVersionDir", () => {
	it("cleanupPartials removes only `*.partial` directories", () => {
		mkdirSync(versionDir(userData, "0.1.0"), { recursive: true });
		mkdirSync(partialDir(userData, "0.5.0"), { recursive: true });
		mkdirSync(partialDir(userData, "0.6.0"), { recursive: true });

		cleanupPartials(userData);

		expect(existsSync(versionDir(userData, "0.1.0"))).toBe(true);
		expect(existsSync(partialDir(userData, "0.5.0"))).toBe(false);
		expect(existsSync(partialDir(userData, "0.6.0"))).toBe(false);
	});

	it("cleanupPartials is a no-op when versions root does not exist", () => {
		expect(() => cleanupPartials(userData)).not.toThrow();
	});

	it("removeVersionDir clears a finalized version dir (post-bad-version cleanup)", () => {
		const cliEntry = stageVersion(userData, "1.0.0");
		expect(existsSync(cliEntry)).toBe(true);
		removeVersionDir(userData, "1.0.0");
		expect(existsSync(versionDir(userData, "1.0.0"))).toBe(false);
	});

	it("removeVersionDir is a no-op for missing dirs and unsafe versions", () => {
		expect(() => removeVersionDir(userData, "1.0.0")).not.toThrow();
		// Unsafe version: silent no-op rather than throw — caller is
		// already running cleanup as best-effort.
		expect(() => removeVersionDir(userData, "../../etc")).not.toThrow();
	});
});

describe("runtime-store: versionDir / partialDir safety", () => {
	it("rejects non-semver version strings", () => {
		expect(() => versionDir(userData, "../../etc")).toThrow(
			/not a valid semver/,
		);
		expect(() => partialDir(userData, "../../etc")).toThrow(
			/not a valid semver/,
		);
		expect(() => versionDir(userData, "abc")).toThrow(/not a valid semver/);
	});
});
