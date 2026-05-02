import {
	existsSync,
	mkdirSync,
	mkdtempSync,
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
	partialDir,
	readPointer,
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

describe("runtime-store", () => {
	describe("readPointer / writePointer", () => {
		it("returns null when missing", () => {
			expect(readPointer(userData)).toBeNull();
		});

		it("returns null when the file is corrupt JSON", () => {
			mkdirSync(path.dirname(pointerPathFor(userData)), { recursive: true });
			writeFileSync(pointerPathFor(userData), "{not-json");
			expect(readPointer(userData)).toBeNull();
		});

		it("round-trips a pointer atomically (writes via tmp + rename)", () => {
			const cliEntry = path.join(versionDir(userData, "0.1.66"), "dist", "cli.js");
			mkdirSync(path.dirname(cliEntry), { recursive: true });
			writeFileSync(cliEntry, "// runtime");

			writePointer(userData, { version: "0.1.66", cliEntry });

			// Tmp file is renamed away atomically — no `.tmp` siblings.
			const dir = path.dirname(pointerPathFor(userData));
			const leftoverTmp =
				existsSync(dir) && readdirSync(dir).some((n) => n.endsWith(".tmp"));
			expect(leftoverTmp).toBe(false);

			expect(readPointer(userData)).toEqual({
				version: "0.1.66",
				cliEntry: path.resolve(cliEntry),
			});
		});

		it("rejects pointers with non-safe version strings", () => {
			mkdirSync(path.dirname(pointerPathFor(userData)), { recursive: true });
			writeFileSync(
				pointerPathFor(userData),
				JSON.stringify({
					version: "../../../etc/passwd",
					cliEntry: path.join(userData, "runtime-store", "x"),
				}),
			);
			expect(readPointer(userData)).toBeNull();
		});

		it("rejects cliEntry outside the runtime-store root (path-traversal defense)", () => {
			// A hand-crafted pointer with a cliEntry pointing outside the
			// store root — the guard in `readPointer` must reject it.
			mkdirSync(path.dirname(pointerPathFor(userData)), { recursive: true });
			writeFileSync(
				pointerPathFor(userData),
				JSON.stringify({
					version: "1.0.0",
					cliEntry: "/etc/passwd",
				}),
			);
			expect(readPointer(userData)).toBeNull();
		});

		it("writePointer rejects an unsafe version segment up front", () => {
			expect(() =>
				writePointer(userData, {
					version: "../../bad",
					cliEntry: path.join(userData, "runtime-store", "x"),
				}),
			).toThrow(/unsafe version/);
		});

		it("writePointer rejects a cliEntry outside the store root", () => {
			expect(() =>
				writePointer(userData, {
					version: "1.0.0",
					cliEntry: "/etc/passwd",
				}),
			).toThrow(/must live inside/);
		});
	});

	describe("clearPointer", () => {
		it("removes the pointer file (and is a no-op when missing)", () => {
			expect(() => clearPointer(userData)).not.toThrow();

			const cliEntry = path.join(versionDir(userData, "0.1.0"), "dist", "cli.js");
			mkdirSync(path.dirname(cliEntry), { recursive: true });
			writeFileSync(cliEntry, "// noop");
			writePointer(userData, { version: "0.1.0", cliEntry });
			expect(readPointer(userData)).not.toBeNull();

			clearPointer(userData);
			expect(readPointer(userData)).toBeNull();
		});
	});

	describe("cleanupPartials", () => {
		it("removes only `*.partial` directories", () => {
			mkdirSync(versionDir(userData, "0.1.0"), { recursive: true });
			mkdirSync(partialDir(userData, "0.5.0"), { recursive: true });
			mkdirSync(partialDir(userData, "0.6.0"), { recursive: true });

			cleanupPartials(userData);

			expect(existsSync(versionDir(userData, "0.1.0"))).toBe(true);
			expect(existsSync(partialDir(userData, "0.5.0"))).toBe(false);
			expect(existsSync(partialDir(userData, "0.6.0"))).toBe(false);
		});

		it("is a no-op when the versions root does not exist", () => {
			expect(() => cleanupPartials(userData)).not.toThrow();
		});
	});

	describe("versionDir / partialDir safety", () => {
		it("rejects path-traversal version strings", () => {
			expect(() => versionDir(userData, "../../etc")).toThrow(/unsafe version/);
			expect(() => partialDir(userData, "../../etc")).toThrow(/unsafe version/);
		});
	});
});
