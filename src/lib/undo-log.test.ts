import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestRepo } from "../../test/helpers.js";
import { DubError } from "./errors.js";
import { initState } from "./state.js";
import {
	clearUndoEntry,
	readUndoEntry,
	saveUndoEntry,
	type UndoEntry,
} from "./undo-log.js";

let dir: string;
let cleanup: () => Promise<void>;

beforeEach(async () => {
	const repo = await createTestRepo();
	dir = repo.dir;
	cleanup = repo.cleanup;
	await initState(dir);
});

afterEach(async () => {
	await cleanup();
});

function makeEntry(overrides?: Partial<UndoEntry>): UndoEntry {
	return {
		operation: "create",
		timestamp: new Date().toISOString(),
		previousBranch: "main",
		previousState: { stacks: [] },
		branchTips: {},
		createdBranches: [],
		...overrides,
	};
}

describe("saveUndoEntry and readUndoEntry", () => {
	it("roundtrips correctly", async () => {
		const entry = makeEntry({
			operation: "create",
			createdBranches: ["feat/a"],
		});
		await saveUndoEntry(entry, dir);
		const loaded = await readUndoEntry(dir);
		expect(loaded).toEqual(entry);
	});
});

describe("readUndoEntry", () => {
	it("throws when no entry exists", async () => {
		await expect(readUndoEntry(dir)).rejects.toThrow(DubError);
		await expect(readUndoEntry(dir)).rejects.toThrow("Nothing to undo");
	});
});

describe("clearUndoEntry", () => {
	it("removes the undo file", async () => {
		await saveUndoEntry(makeEntry(), dir);
		await clearUndoEntry(dir);
		await expect(readUndoEntry(dir)).rejects.toThrow("Nothing to undo");
	});
});

describe("overwrite behavior", () => {
	it("second save overwrites first", async () => {
		const first = makeEntry({
			operation: "create",
			createdBranches: ["feat/a"],
		});
		const second = makeEntry({ operation: "restack", createdBranches: [] });

		await saveUndoEntry(first, dir);
		await saveUndoEntry(second, dir);

		const loaded = await readUndoEntry(dir);
		expect(loaded.operation).toBe("restack");
	});
});
