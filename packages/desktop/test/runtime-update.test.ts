/**
 * Unit tests for `runtime-update.checkAndStageLatestRuntime`.
 *
 * pacote is mocked at the module boundary so these tests don't hit
 * the real npm registry. Each test defines `manifest()` and
 * `extract()` behavior, then asserts the StageOutcome.
 */

import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	markBadVersion,
	readPointer,
	versionDir,
	writePointer,
} from "../src/runtime-store.js";
import { checkAndStageLatestRuntime } from "../src/runtime-update.js";

// pacote.manifest / pacote.extract are mocked here. Each test sets
// the implementation it needs via `manifestMock.mockResolvedValueOnce`
// or `extractMock.mockImplementationOnce`.
const manifestMock = vi.fn();
const extractMock = vi.fn();

vi.mock("pacote", () => ({
	default: {
		manifest: (...args: unknown[]) => manifestMock(...args),
		extract: (...args: unknown[]) => extractMock(...args),
	},
}));

let userData: string;
let nativeDepsSource: string;

beforeEach(() => {
	userData = mkdtempSync(path.join(tmpdir(), "runtime-update-"));
	nativeDepsSource = mkdtempSync(path.join(tmpdir(), "runtime-update-deps-"));
	// Pretend `node-pty` is bundled — the updater copies it into each
	// staged version. A bare directory is enough for `cp -r`.
	mkdirSync(path.join(nativeDepsSource, "node-pty"), { recursive: true });
	writeFileSync(
		path.join(nativeDepsSource, "node-pty", "package.json"),
		JSON.stringify({ name: "node-pty", version: "1.0.0" }),
	);

	manifestMock.mockReset();
	extractMock.mockReset();

	// Default `extract` implementation: lay out a `dist/cli.js` at the
	// staged path so the post-extract sanity check passes. Tests that
	// want to exercise failure modes override this.
	extractMock.mockImplementation(async (_spec: string, dest: string) => {
		mkdirSync(path.join(dest, "dist"), { recursive: true });
		writeFileSync(path.join(dest, "dist", "cli.js"), "// runtime");
	});
});

afterEach(() => {
	rmSync(userData, { recursive: true, force: true });
	rmSync(nativeDepsSource, { recursive: true, force: true });
});

describe("checkAndStageLatestRuntime: version gate", () => {
	it("returns up-to-date when latest <= currentVersion", async () => {
		manifestMock.mockResolvedValueOnce({ version: "0.1.0", engines: {} });

		const outcome = await checkAndStageLatestRuntime({
			userData,
			currentVersion: "0.1.0",
			nativeDepsSource,
		});

		expect(outcome).toEqual({ kind: "up-to-date" });
		expect(extractMock).not.toHaveBeenCalled();
		expect(readPointer(userData)).toBeNull();
	});

	it("returns already-staged when pointer.version === latest", async () => {
		// Pre-stage a pointer for 0.5.0 so a re-check on the same
		// version doesn't re-extract.
		const cliEntry = path.join(versionDir(userData, "0.5.0"), "dist", "cli.js");
		mkdirSync(path.dirname(cliEntry), { recursive: true });
		writeFileSync(cliEntry, "// runtime");
		writePointer(userData, { version: "0.5.0", cliEntry });

		manifestMock.mockResolvedValueOnce({ version: "0.5.0", engines: {} });

		const outcome = await checkAndStageLatestRuntime({
			userData,
			currentVersion: "0.4.0",
			nativeDepsSource,
		});

		expect(outcome).toEqual({ kind: "already-staged" });
		expect(extractMock).not.toHaveBeenCalled();
	});

	it("throws when the registry returns a non-semver version", async () => {
		manifestMock.mockResolvedValueOnce({ version: "garbage", engines: {} });

		await expect(
			checkAndStageLatestRuntime({
				userData,
				currentVersion: "0.1.0",
				nativeDepsSource,
			}),
		).rejects.toThrow(/non-semver/);
	});

	it("treats a non-semver currentVersion as 'unknown' and proceeds to stage", async () => {
		// Defends against a corrupted pointer leaking a non-semver
		// version into the gate. Without the guard, semver.gt would
		// throw and the whole check would explode every cycle.
		manifestMock.mockResolvedValueOnce({ version: "1.0.0", engines: {} });

		const outcome = await checkAndStageLatestRuntime({
			userData,
			currentVersion: "garbage",
			nativeDepsSource,
		});

		expect(outcome.kind).toBe("staged");
	});
});

describe("checkAndStageLatestRuntime: bad-version + engines gates", () => {
	it("returns bad-version (without extracting) when latest is on the bad list", async () => {
		// The blocker case: a previous launch already failed startup on
		// 1.0.0 and called markBadVersion. The 30-min check must not
		// re-stage it.
		markBadVersion(userData, "1.0.0");
		manifestMock.mockResolvedValueOnce({ version: "1.0.0", engines: {} });

		const outcome = await checkAndStageLatestRuntime({
			userData,
			currentVersion: "0.5.0",
			nativeDepsSource,
		});

		expect(outcome).toEqual({ kind: "bad-version", version: "1.0.0" });
		expect(extractMock).not.toHaveBeenCalled();
	});

	it("returns engines-incompatible when manifest engines.node is unsatisfied by nodeVersion", async () => {
		manifestMock.mockResolvedValueOnce({
			version: "2.0.0",
			engines: { node: ">=24.0.0" },
		});

		const outcome = await checkAndStageLatestRuntime({
			userData,
			currentVersion: "0.5.0",
			nativeDepsSource,
			nodeVersion: "22.10.0",
		});

		expect(outcome).toEqual({
			kind: "engines-incompatible",
			version: "2.0.0",
			required: ">=24.0.0",
		});
		expect(extractMock).not.toHaveBeenCalled();
	});

	it("ignores engines gate when nodeVersion is not provided (test-only opt-out)", async () => {
		manifestMock.mockResolvedValueOnce({
			version: "2.0.0",
			engines: { node: ">=99" },
		});

		const outcome = await checkAndStageLatestRuntime({
			userData,
			currentVersion: "0.5.0",
			nativeDepsSource,
		});

		expect(outcome.kind).toBe("staged");
	});

	it("stages when engines.node is satisfied by nodeVersion", async () => {
		manifestMock.mockResolvedValueOnce({
			version: "2.0.0",
			engines: { node: ">=22.0.0" },
		});

		const outcome = await checkAndStageLatestRuntime({
			userData,
			currentVersion: "0.5.0",
			nativeDepsSource,
			nodeVersion: "22.10.0",
		});

		expect(outcome).toEqual({ kind: "staged", stagedVersion: "2.0.0" });
	});
});

describe("checkAndStageLatestRuntime: staging", () => {
	it("stages the package, copies node-pty, and writes the pointer atomically", async () => {
		manifestMock.mockResolvedValueOnce({ version: "1.0.0", engines: {} });

		const outcome = await checkAndStageLatestRuntime({
			userData,
			currentVersion: "0.5.0",
			nativeDepsSource,
		});

		expect(outcome).toEqual({ kind: "staged", stagedVersion: "1.0.0" });

		// Pointer round-trips, file actually exists, no leftover *.tmp.
		const pointer = readPointer(userData);
		expect(pointer?.version).toBe("1.0.0");
		expect(pointer?.cliEntry).toBe(
			path.join(versionDir(userData, "1.0.0"), "dist", "cli.js"),
		);

		const finalDir = versionDir(userData, "1.0.0");
		expect(
			readdirSync(path.join(finalDir, "node_modules")).includes("node-pty"),
		).toBe(true);
		expect(
			readdirSync(path.dirname(finalDir)).every((n) => !n.endsWith(".partial")),
		).toBe(true);
	});

	it("throws (and leaves pointer untouched) when bundled node-pty is missing", async () => {
		rmSync(path.join(nativeDepsSource, "node-pty"), { recursive: true });
		manifestMock.mockResolvedValueOnce({ version: "1.0.0", engines: {} });

		await expect(
			checkAndStageLatestRuntime({
				userData,
				currentVersion: "0.5.0",
				nativeDepsSource,
			}),
		).rejects.toThrow(/bundled node-pty not found/);

		expect(readPointer(userData)).toBeNull();
	});

	it("throws when the extracted package has no dist/cli.js (corrupt tarball)", async () => {
		// Override the default extract with one that produces an empty
		// directory — simulating a malformed tarball.
		extractMock.mockImplementationOnce(async (_spec: string, dest: string) => {
			mkdirSync(dest, { recursive: true });
		});
		manifestMock.mockResolvedValueOnce({ version: "1.0.0", engines: {} });

		await expect(
			checkAndStageLatestRuntime({
				userData,
				currentVersion: "0.5.0",
				nativeDepsSource,
			}),
		).rejects.toThrow(/missing dist\/cli\.js/);

		expect(readPointer(userData)).toBeNull();
	});

	it("recovers from a stale `<v>.partial/` left by a prior interrupted run", async () => {
		// Manually create the partial dir to simulate a previous extract
		// that crashed mid-way. The new staging must clobber it cleanly.
		mkdirSync(path.join(versionDir(userData, "1.0.0") + ".partial", "junk"), {
			recursive: true,
		});

		manifestMock.mockResolvedValueOnce({ version: "1.0.0", engines: {} });

		const outcome = await checkAndStageLatestRuntime({
			userData,
			currentVersion: "0.5.0",
			nativeDepsSource,
		});

		expect(outcome.kind).toBe("staged");
		expect(readPointer(userData)?.version).toBe("1.0.0");
	});
});
