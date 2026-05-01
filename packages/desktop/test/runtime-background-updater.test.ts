import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createRuntimeBackgroundUpdater } from "../src/runtime-background-updater.js";
import type { RuntimeInstallerConfig } from "../src/runtime-installer.js";
import { createRuntimeStore, type RuntimeStore } from "../src/runtime-store.js";

let root: string;
let store: RuntimeStore;
let nativeSrc: string;
let installerConfig: RuntimeInstallerConfig;

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "runtime-bgu-"));
	store = createRuntimeStore(path.join(root, "rs"));
	nativeSrc = path.join(root, "node_modules");
	mkdirSync(path.join(nativeSrc, "node-pty"), { recursive: true });
	writeFileSync(path.join(nativeSrc, "node-pty", "index.js"), "// native");
	installerConfig = {
		store,
		nativeDepsSource: nativeSrc,
		extractImpl: vi.fn(async (_spec, dest) => {
			mkdirSync(path.join(dest, "dist"), { recursive: true });
			writeFileSync(path.join(dest, "dist", "cli.js"), "// runtime");
			return { resolved: "x", integrity: "x", from: "x" };
		}) as unknown as RuntimeInstallerConfig["extractImpl"],
	};
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function makeManifest(version: string) {
	return vi.fn(async () => ({ version }) as { version: string }) as unknown as
		typeof import("pacote").manifest;
}

describe("createRuntimeBackgroundUpdater", () => {
	it("installs and writes pointer when latest is newer than current", async () => {
		const onStaged = vi.fn();
		const updater = createRuntimeBackgroundUpdater({
			store,
			installerConfig,
			getCurrentVersion: () => "0.1.0",
			onStaged,
			manifestImpl: makeManifest("0.2.0"),
			intervalMs: 1_000_000,
			firstCheckDelayMs: 1_000_000,
		});

		await updater.checkNow();

		expect(store.readPointer()).toMatchObject({
			version: "0.2.0",
			cliEntry: "dist/cli.js",
		});
		expect(onStaged).toHaveBeenCalledWith("0.2.0");

		await updater.dispose();
	});

	it("skips when latest equals current — no install, no pointer write, no callback", async () => {
		const onStaged = vi.fn();
		const updater = createRuntimeBackgroundUpdater({
			store,
			installerConfig,
			getCurrentVersion: () => "0.2.0",
			onStaged,
			manifestImpl: makeManifest("0.2.0"),
			firstCheckDelayMs: 1_000_000,
		});

		await updater.checkNow();

		expect(installerConfig.extractImpl).not.toHaveBeenCalled();
		expect(store.readPointer()).toBeNull();
		expect(onStaged).not.toHaveBeenCalled();

		await updater.dispose();
	});

	it("does not re-install the same staged version on a subsequent tick", async () => {
		const onStaged = vi.fn();
		const updater = createRuntimeBackgroundUpdater({
			store,
			installerConfig,
			// getCurrentVersion still returns the OLD running version because
			// the user hasn't restarted. The updater must short-circuit via
			// its `lastStaged` cache instead of re-installing.
			getCurrentVersion: () => "0.1.0",
			onStaged,
			manifestImpl: makeManifest("0.2.0"),
			firstCheckDelayMs: 1_000_000,
		});

		await updater.checkNow();
		await updater.checkNow();

		expect(installerConfig.extractImpl).toHaveBeenCalledTimes(1);
		expect(onStaged).toHaveBeenCalledTimes(1);

		await updater.dispose();
	});

	it("collapses concurrent checkNow() calls into a single install (single-flight)", async () => {
		const updater = createRuntimeBackgroundUpdater({
			store,
			installerConfig,
			getCurrentVersion: () => "0.1.0",
			onStaged: vi.fn(),
			manifestImpl: makeManifest("0.2.0"),
			firstCheckDelayMs: 1_000_000,
		});

		await Promise.all([updater.checkNow(), updater.checkNow(), updater.checkNow()]);

		expect(installerConfig.extractImpl).toHaveBeenCalledTimes(1);

		await updater.dispose();
	});

	it("does not mutate the pointer when the install fails", async () => {
		// Pre-existing pointer that should survive the failed install.
		mkdirSync(path.join(store.versionDir("0.1.0"), "dist"), { recursive: true });
		writeFileSync(path.join(store.versionDir("0.1.0"), "dist", "cli.js"), "// old");
		store.writePointer({
			version: "0.1.0",
			installedAt: "2025-01-01T00:00:00.000Z",
			cliEntry: "dist/cli.js",
		});

		const onStaged = vi.fn();
		const updater = createRuntimeBackgroundUpdater({
			store,
			installerConfig: {
				...installerConfig,
				extractImpl: vi.fn(async () => {
					throw new Error("simulated 503 from registry");
				}) as unknown as RuntimeInstallerConfig["extractImpl"],
			},
			getCurrentVersion: () => "0.1.0",
			onStaged,
			manifestImpl: makeManifest("0.2.0"),
			firstCheckDelayMs: 1_000_000,
		});

		await updater.checkNow(); // must not throw

		expect(store.readPointer()).toMatchObject({ version: "0.1.0" });
		expect(onStaged).not.toHaveBeenCalled();

		await updater.dispose();
	});

	it("swallows manifest fetch failures (offline / registry down)", async () => {
		const onStaged = vi.fn();
		const updater = createRuntimeBackgroundUpdater({
			store,
			installerConfig,
			getCurrentVersion: () => "0.1.0",
			onStaged,
			manifestImpl: vi.fn(async () => {
				throw new Error("ENOTFOUND registry.npmjs.org");
			}) as unknown as typeof import("pacote").manifest,
			firstCheckDelayMs: 1_000_000,
		});

		await updater.checkNow(); // must not throw

		expect(installerConfig.extractImpl).not.toHaveBeenCalled();
		expect(onStaged).not.toHaveBeenCalled();

		await updater.dispose();
	});
});
