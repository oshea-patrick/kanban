/**
 * Direct tests for `createRuntimeAutoUpdate()` — the wiring layer
 * between the orchestrator's cliEntryOverride callbacks and the
 * runtime-store/runtime-update modules.
 *
 * `checkAndStageLatestRuntime` is mocked via `vi.mock()` because the
 * real implementation hits the npm registry. Everything else (the
 * pointer/bad-versions store, the file-existence check, the rollback
 * sequence) runs against a real userData tmpdir so the on-disk
 * invariants are exercised.
 */

import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

import {
	cliEntryFor,
	isBadVersion,
	readPointer,
	versionDir,
	writePointer,
} from "../src/runtime-store.js";
import { checkAndStageLatestRuntime } from "../src/runtime-update.js";
import { createRuntimeAutoUpdate } from "../src/runtime-auto-update.js";

vi.mock("../src/runtime-update.js", () => ({
	checkAndStageLatestRuntime: vi.fn(),
}));

const stagedManifest = checkAndStageLatestRuntime as unknown as ReturnType<
	typeof vi.fn
>;

let userData: string;
let resourcesPath: string;
// `broadcast` matches `RuntimeAutoUpdateDeps.broadcast`; vi.fn() with no
// arg type infers to `Mock<Procedure | Constructable>`, which TS won't
// assign to a fixed signature without an explicit cast.
type Broadcast = (channel: string, ...args: unknown[]) => void;
let broadcast: Broadcast & { mock: ReturnType<typeof vi.fn>["mock"] };

const SHELL_VERSION = "0.1.70";
const BUNDLED_VERSION = "0.1.70";

function setBundled(version: string): void {
	const cliDir = path.join(resourcesPath, "app.asar.unpacked", "cli");
	mkdirSync(cliDir, { recursive: true });
	writeFileSync(
		path.join(cliDir, "package.json"),
		JSON.stringify({ name: "kanban", version }),
	);
}

/** Lay out `versions/<v>/dist/cli.js` so a pointer to it is valid. */
function stageVersion(version: string): string {
	const cliEntry = cliEntryFor(userData, version);
	mkdirSync(path.dirname(cliEntry), { recursive: true });
	writeFileSync(cliEntry, "// runtime");
	return cliEntry;
}

beforeEach(() => {
	userData = mkdtempSync(path.join(tmpdir(), "auto-update-userData-"));
	resourcesPath = mkdtempSync(path.join(tmpdir(), "auto-update-resources-"));
	setBundled(BUNDLED_VERSION);
	broadcast = vi.fn() as unknown as typeof broadcast;
	stagedManifest.mockReset();
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
	rmSync(userData, { recursive: true, force: true });
	rmSync(resourcesPath, { recursive: true, force: true });
	vi.restoreAllMocks();
});

function buildAutoUpdate(overrides: {
	isPackaged?: boolean;
	shellVersion?: string;
} = {}) {
	return createRuntimeAutoUpdate({
		isPackaged: overrides.isPackaged ?? true,
		userData,
		resourcesPath,
		shellVersion: overrides.shellVersion ?? SHELL_VERSION,
		broadcast,
	});
}

describe("createRuntimeAutoUpdate", () => {
	it("returns null when not packaged (dev runs the bundled cli)", () => {
		expect(buildAutoUpdate({ isPackaged: false })).toBeNull();
	});
});

describe("createRuntimeAutoUpdate: resolveCliEntryOverride", () => {
	it("returns null and leaves the store untouched when no pointer exists", () => {
		const auto = buildAutoUpdate();
		expect(auto?.resolveCliEntryOverride()).toBeNull();
		expect(broadcast).not.toHaveBeenCalled();
	});

	it("returns the staged cliEntry when pointer.version > bundled", () => {
		const cliEntry = stageVersion("0.1.71");
		writePointer(userData, { version: "0.1.71", cliEntry });
		const auto = buildAutoUpdate();
		expect(auto?.resolveCliEntryOverride()).toBe(cliEntry);
		// Pointer must remain on disk — this is the happy path, not a
		// self-repair branch.
		expect(readPointer(userData)).not.toBeNull();
	});

	it("clears a stale pointer whose version <= bundled (older staged + newer shell)", () => {
		// Regression: previously loadOverride() ignored pointer.version
		// and would keep launching an older staged runtime forever after
		// a shell upgrade.
		const cliEntry = stageVersion("0.1.69");
		writePointer(userData, { version: "0.1.69", cliEntry });

		const auto = buildAutoUpdate();
		expect(auto?.resolveCliEntryOverride()).toBeNull();
		expect(readPointer(userData)).toBeNull();
	});

	it("clears a pointer whose cliEntry no longer exists on disk", () => {
		const cliEntry = stageVersion("0.1.71");
		writePointer(userData, { version: "0.1.71", cliEntry });
		rmSync(versionDir(userData, "0.1.71"), { recursive: true });

		const auto = buildAutoUpdate();
		expect(auto?.resolveCliEntryOverride()).toBeNull();
		expect(readPointer(userData)).toBeNull();
	});

	it("clears a non-canonical pointer (treated as no pointer by readPointer)", () => {
		// A tampered current.json with cliEntry pointing outside the
		// runtime-store should never be honored.
		mkdirSync(path.join(userData, "runtime-store"), { recursive: true });
		writeFileSync(
			path.join(userData, "runtime-store", "current.json"),
			JSON.stringify({ version: "0.1.71", cliEntry: "/etc/passwd" }),
		);

		const auto = buildAutoUpdate();
		expect(auto?.resolveCliEntryOverride()).toBeNull();
	});

	it("falls back to shellVersion as bundled when app.asar.unpacked/cli/package.json is missing", () => {
		rmSync(path.join(resourcesPath, "app.asar.unpacked"), {
			recursive: true,
			force: true,
		});
		const cliEntry = stageVersion("0.1.71");
		writePointer(userData, { version: "0.1.71", cliEntry });

		const auto = buildAutoUpdate({ shellVersion: "0.1.71" });
		// shellVersion 0.1.71 == pointer 0.1.71 → still <= bundled, so cleared.
		expect(auto?.resolveCliEntryOverride()).toBeNull();
	});
});

describe("createRuntimeAutoUpdate: onCliEntryOverrideFailed (rollback)", () => {
	it("marks the failed version bad, removes its dir, clears pointer, and broadcasts", () => {
		const cliEntry = stageVersion("0.1.71");
		writePointer(userData, { version: "0.1.71", cliEntry });

		const auto = buildAutoUpdate();
		auto?.onCliEntryOverrideFailed("spawn ENOENT");

		expect(isBadVersion(userData, "0.1.71")).toBe(true);
		expect(readPointer(userData)).toBeNull();
		// Version dir is removed so a future staging of the same version
		// can extract cleanly without a leftover-files conflict.
		expect(() => readFileSync(cliEntry, "utf8")).toThrow();
		expect(broadcast).toHaveBeenCalledWith("runtime:rolled-back", "0.1.71");
	});

	it("broadcasts rollback with null when no pointer is present", () => {
		const auto = buildAutoUpdate();
		auto?.onCliEntryOverrideFailed("bundled spawn failed");
		expect(broadcast).toHaveBeenCalledWith("runtime:rolled-back", null);
	});
});

describe("createRuntimeAutoUpdate: runCheck (background updater)", () => {
	async function tick(): Promise<void> {
		// Yield long enough for setTimeout(0) + the awaited mock to settle.
		await vi.advanceTimersByTimeAsync(30_000);
		await Promise.resolve();
	}

	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("broadcasts runtime:update-staged on a successful staged outcome", async () => {
		stagedManifest.mockResolvedValueOnce({ kind: "staged", version: "0.1.72" });
		const auto = buildAutoUpdate();
		auto?.scheduleChecks();

		await tick();

		expect(stagedManifest).toHaveBeenCalledTimes(1);
		expect(broadcast).toHaveBeenCalledWith("runtime:update-staged", "0.1.72");
	});

	it("uses max(pointer, bundled) as currentVersion (not the stale older pointer)", async () => {
		// User just upgraded the shell: bundled is 0.1.70, but userData
		// still has a pointer from before that says 0.1.69. The check
		// must compare 'latest' against bundled (0.1.70), not 0.1.69 —
		// otherwise we'd think 0.1.70 is "newer" and re-stage every interval.
		const cliEntry = stageVersion("0.1.69");
		writePointer(userData, { version: "0.1.69", cliEntry });
		stagedManifest.mockResolvedValueOnce({ kind: "up-to-date" });

		const auto = buildAutoUpdate();
		auto?.scheduleChecks();
		await tick();

		expect(stagedManifest).toHaveBeenCalledWith(
			expect.objectContaining({ currentVersion: BUNDLED_VERSION }),
		);
	});

	it("uses the staged version as currentVersion when pointer > bundled", async () => {
		const cliEntry = stageVersion("0.1.71");
		writePointer(userData, { version: "0.1.71", cliEntry });
		stagedManifest.mockResolvedValueOnce({ kind: "already-staged" });

		const auto = buildAutoUpdate();
		auto?.scheduleChecks();
		await tick();

		expect(stagedManifest).toHaveBeenCalledWith(
			expect.objectContaining({ currentVersion: "0.1.71" }),
		);
	});

	it("does not broadcast on up-to-date / already-staged / bad-version outcomes", async () => {
		stagedManifest.mockResolvedValueOnce({ kind: "up-to-date" });
		const auto = buildAutoUpdate();
		auto?.scheduleChecks();
		await tick();

		expect(broadcast).not.toHaveBeenCalledWith(
			"runtime:update-staged",
			expect.anything(),
		);
	});

	it("swallows pacote/network errors so the timer keeps firing", async () => {
		stagedManifest.mockRejectedValueOnce(new Error("ENOTFOUND registry"));
		const auto = buildAutoUpdate();
		auto?.scheduleChecks();
		await tick();
		// No throw, no broadcast — the next interval tick can run normally.
		expect(broadcast).not.toHaveBeenCalled();
	});

	it("stop() prevents pending and future checks from running", async () => {
		stagedManifest.mockResolvedValue({ kind: "up-to-date" });
		const auto = buildAutoUpdate();
		auto?.scheduleChecks();
		auto?.stop();

		await vi.advanceTimersByTimeAsync(30 * 60_000 * 5);
		expect(stagedManifest).not.toHaveBeenCalled();
	});
});
