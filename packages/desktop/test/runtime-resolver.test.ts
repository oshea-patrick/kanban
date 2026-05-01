import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveRuntime } from "../src/runtime-resolver.js";
import { createRuntimeStore, type RuntimeStore } from "../src/runtime-store.js";

let root: string;
let store: RuntimeStore;
const bundledCliEntry = process.execPath; // any file that exists is fine
const bundledVersion = "0.0.1";

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "runtime-resolver-"));
	store = createRuntimeStore(root);
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

/** Materialise a healthy `versions/<v>/dist/cli.js` runtime tree. */
function stage(version: string): void {
	const dist = path.join(store.versionDir(version), "dist");
	mkdirSync(dist, { recursive: true });
	writeFileSync(path.join(dist, "cli.js"), "// runtime");
}

function pointAt(version: string): void {
	store.writePointer({
		version,
		installedAt: "2025-01-01T00:00:00.000Z",
		cliEntry: "dist/cli.js",
	});
}

describe("resolveRuntime", () => {
	it("falls back to bundled when no pointer + no installed versions", () => {
		const r = resolveRuntime({ store, bundledCliEntry, bundledVersion });
		expect(r.source).toBe("bundled");
		expect(r.cliEntryAbsolutePath).toBe(bundledCliEntry);
		expect(r.version).toBe(bundledVersion);
		expect(r.pointerVersion).toBeNull();
	});

	it("returns the pointer arm when pointer is healthy and not bad", () => {
		stage("0.1.66");
		pointAt("0.1.66");

		const r = resolveRuntime({ store, bundledCliEntry, bundledVersion });
		expect(r.source).toBe("pointer");
		expect(r.version).toBe("0.1.66");
		expect(r.pointerVersion).toBe("0.1.66");
	});

	it("falls back to highest-semver healthy non-pointer version when pointer is bad-marked", () => {
		stage("0.1.0");
		stage("0.2.0");
		stage("0.10.0");
		pointAt("0.10.0");
		store.markBad("0.10.0");

		const r = resolveRuntime({ store, bundledCliEntry, bundledVersion });
		expect(r.source).toBe("fallback-version");
		expect(r.version).toBe("0.2.0"); // 0.1.0 < 0.2.0 by semver
		expect(r.pointerVersion).toBe("0.10.0"); // pointer is still 0.10.0 even though bad
	});

	it("skips bad versions in the fallback arm", () => {
		stage("0.1.0");
		stage("0.2.0");
		store.markBad("0.2.0");
		// no pointer

		const r = resolveRuntime({ store, bundledCliEntry, bundledVersion });
		expect(r.source).toBe("fallback-version");
		expect(r.version).toBe("0.1.0");
	});

	it("falls all the way back to bundled when every installed version is bad", () => {
		stage("0.1.0");
		store.markBad("0.1.0");

		const r = resolveRuntime({ store, bundledCliEntry, bundledVersion });
		expect(r.source).toBe("bundled");
	});

	it("treats a healthy version with a missing cli.js as unhealthy", () => {
		mkdirSync(store.versionDir("0.1.0"), { recursive: true });
		// no dist/cli.js
		pointAt("0.1.0");

		const r = resolveRuntime({ store, bundledCliEntry, bundledVersion });
		expect(r.source).toBe("bundled"); // pointer-arm fails the cli check, no fallback either
	});

	it("throws if even the bundled cli.js doesn't exist (packaging failure)", () => {
		const broken = path.join(root, "does-not-exist.js");
		expect(() =>
			resolveRuntime({ store, bundledCliEntry: broken, bundledVersion: null }),
		).toThrow(/bundled cli\.js missing/);
	});
});
