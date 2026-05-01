import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createRuntimeStore, type RuntimeStore } from "../src/runtime-store.js";

let root: string;
let store: RuntimeStore;

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "runtime-store-"));
	store = createRuntimeStore(root);
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

/** Materialise a "finalized" runtime tree (the layout the resolver/installer expect). */
function makeVersion(version: string): void {
	mkdirSync(store.versionDir(version), { recursive: true });
}

describe("createRuntimeStore", () => {
	it("readPointer returns null when missing or corrupt", () => {
		expect(store.readPointer()).toBeNull();
		mkdirSync(root, { recursive: true });
		writeFileSync(store.pointerPath, "{not-json");
		expect(store.readPointer()).toBeNull();
	});

	it("round-trips a pointer atomically (writes via tmp + rename)", () => {
		makeVersion("0.1.66");
		const pointer = {
			version: "0.1.66",
			installedAt: "2025-01-01T00:00:00.000Z",
			cliEntry: "dist/cli.js",
		};
		store.writePointer(pointer);
		expect(existsSync(`${store.pointerPath}.tmp`)).toBe(false); // tmp cleaned
		expect(store.readPointer()).toEqual(pointer);
	});

	it("readPointer returns null when the version dir no longer exists", () => {
		// Simulate post-rollback rmSync of the version tree (pointer is stale).
		store.writePointer({
			version: "9.9.9",
			installedAt: "x",
			cliEntry: "dist/cli.js",
		});
		expect(store.readPointer()).toBeNull();
	});

	it("readPointer rejects non-semver versions and missing fields", () => {
		mkdirSync(root, { recursive: true });
		writeFileSync(store.pointerPath, JSON.stringify({ version: "lol" }));
		expect(store.readPointer()).toBeNull();
	});

	it("markBad / isBad", () => {
		expect(store.isBad("0.1.66")).toBe(false);
		store.markBad("0.1.66");
		expect(store.isBad("0.1.66")).toBe(true);
	});

	it("listVersions returns finalized versions in semver-descending order, ignoring partial/bad/junk", () => {
		makeVersion("0.1.0");
		makeVersion("0.2.0");
		makeVersion("0.10.0");
		mkdirSync(store.partialDir("0.5.0"), { recursive: true });
		mkdirSync(path.join(store.versionsDir, "not-a-version"), { recursive: true });
		store.markBad("0.2.0"); // bad-marker is a sibling FILE, not a dir → still finalized

		expect(store.listVersions()).toEqual(["0.10.0", "0.2.0", "0.1.0"]);
	});

	it("cleanupPartials removes only *.partial dirs", () => {
		makeVersion("0.1.0");
		mkdirSync(store.partialDir("0.5.0"), { recursive: true });
		mkdirSync(store.partialDir("0.6.0"), { recursive: true });

		store.cleanupPartials();

		expect(existsSync(store.versionDir("0.1.0"))).toBe(true);
		expect(existsSync(store.partialDir("0.5.0"))).toBe(false);
		expect(existsSync(store.partialDir("0.6.0"))).toBe(false);
	});

	describe("finalize", () => {
		it("renames partial → final atomically", () => {
			const partial = store.partialDir("0.1.66");
			mkdirSync(path.join(partial, "dist"), { recursive: true });
			writeFileSync(path.join(partial, "dist", "cli.js"), "// runtime");

			store.finalize("0.1.66");

			expect(existsSync(partial)).toBe(false);
			expect(existsSync(path.join(store.versionDir("0.1.66"), "dist", "cli.js"))).toBe(true);
		});

		it("replaces an existing finalized tree (re-install of same version)", () => {
			mkdirSync(store.versionDir("0.1.66"), { recursive: true });
			writeFileSync(path.join(store.versionDir("0.1.66"), "stale.txt"), "old");

			mkdirSync(path.join(store.partialDir("0.1.66"), "dist"), { recursive: true });
			writeFileSync(
				path.join(store.partialDir("0.1.66"), "dist", "cli.js"),
				"// new",
			);
			store.finalize("0.1.66");

			expect(existsSync(path.join(store.versionDir("0.1.66"), "stale.txt"))).toBe(false);
			expect(existsSync(path.join(store.versionDir("0.1.66"), "dist", "cli.js"))).toBe(true);
		});

		it("throws if no partial exists", () => {
			expect(() => store.finalize("0.1.66")).toThrow(/missing partial install/);
		});
	});
});
