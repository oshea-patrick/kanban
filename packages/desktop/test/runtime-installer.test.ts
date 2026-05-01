import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installRuntime } from "../src/runtime-installer.js";
import { createRuntimeStore, type RuntimeStore } from "../src/runtime-store.js";

let root: string;
let store: RuntimeStore;
let nativeSrc: string;

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "runtime-installer-"));
	store = createRuntimeStore(path.join(root, "rs"));
	// Stub `app.asar.unpacked/node_modules/node-pty/` so the native staging
	// step has something to copy.
	nativeSrc = path.join(root, "node_modules");
	mkdirSync(path.join(nativeSrc, "node-pty"), { recursive: true });
	writeFileSync(path.join(nativeSrc, "node-pty", "index.js"), "// native");
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

/**
 * Fake `pacote.extract` that materialises the same on-disk shape the real
 * one produces (it strips the `package/` prefix, so `dest/dist/cli.js` is
 * the runtime entry).
 */
function fakeExtract(version: string): typeof import("pacote").extract {
	return vi.fn(async (_spec: string, dest: string) => {
		mkdirSync(path.join(dest, "dist"), { recursive: true });
		writeFileSync(path.join(dest, "dist", "cli.js"), `// kanban@${version}`);
		return { resolved: "tarball", integrity: "sha512-fake", from: _spec };
	}) as unknown as typeof import("pacote").extract;
}

describe("installRuntime", () => {
	it("calls pacote.extract with the kanban@<version> spec into the partial dir, then atomically finalizes", async () => {
		const extract = fakeExtract("0.1.66");

		const result = await installRuntime(
			{ store, nativeDepsSource: nativeSrc, extractImpl: extract },
			"0.1.66",
		);

		expect(extract).toHaveBeenCalledTimes(1);
		const [spec, dest] = (extract as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(spec).toBe("kanban@0.1.66");
		expect(dest).toBe(store.partialDir("0.1.66"));

		expect(existsSync(store.partialDir("0.1.66"))).toBe(false); // moved
		expect(existsSync(path.join(store.versionDir("0.1.66"), "dist", "cli.js"))).toBe(true);
		expect(readFileSync(path.join(store.versionDir("0.1.66"), "dist", "cli.js"), "utf8")).toBe(
			"// kanban@0.1.66",
		);
		expect(result).toEqual({ version: "0.1.66", cliEntry: "dist/cli.js" });
	});

	it("stages native deps (node-pty) into the runtime tree", async () => {
		await installRuntime(
			{ store, nativeDepsSource: nativeSrc, extractImpl: fakeExtract("0.1.66") },
			"0.1.66",
		);

		const stagedNodePty = path.join(
			store.versionDir("0.1.66"),
			"node_modules",
			"node-pty",
			"index.js",
		);
		expect(existsSync(stagedNodePty)).toBe(true);
		expect(readFileSync(stagedNodePty, "utf8")).toBe("// native");
	});

	it("fails loudly if a required native dep is missing", async () => {
		const emptyNodeModules = path.join(root, "empty");
		mkdirSync(emptyNodeModules);

		await expect(
			installRuntime(
				{ store, nativeDepsSource: emptyNodeModules, extractImpl: fakeExtract("0.1.66") },
				"0.1.66",
			),
		).rejects.toThrow(/native dep 'node-pty' not found/);

		// Failed install must not have promoted anything to final.
		expect(existsSync(store.versionDir("0.1.66"))).toBe(false);
	});

	it("fails loudly if the extracted tree is missing dist/cli.js", async () => {
		const extractWithoutCli = vi.fn(async (_spec: string, dest: string) => {
			mkdirSync(dest, { recursive: true });
			writeFileSync(path.join(dest, "README.md"), "no cli here");
			return { resolved: "x", integrity: "x", from: "x" };
		}) as unknown as typeof import("pacote").extract;

		await expect(
			installRuntime(
				{ store, nativeDepsSource: nativeSrc, extractImpl: extractWithoutCli },
				"0.1.66",
			),
		).rejects.toThrow(/extracted tree missing dist\/cli\.js/);

		expect(existsSync(store.versionDir("0.1.66"))).toBe(false);
	});

	it("sweeps stale partial dirs from a previous crashed install before extracting", async () => {
		const stalePartial = store.partialDir("0.0.99");
		mkdirSync(stalePartial, { recursive: true });
		writeFileSync(path.join(stalePartial, "stale.txt"), "old");

		await installRuntime(
			{ store, nativeDepsSource: nativeSrc, extractImpl: fakeExtract("0.1.66") },
			"0.1.66",
		);

		expect(existsSync(stalePartial)).toBe(false);
	});
});
