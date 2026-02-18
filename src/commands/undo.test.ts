import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestRepo, gitInRepo } from "../../test/helpers";
import { DubError } from "../lib/errors";
import { branchExists, getBranchTip, getCurrentBranch } from "../lib/git";
import { readState } from "../lib/state";
import { readUndoEntry } from "../lib/undo-log";
import { create } from "./create";
import { init } from "./init";
import { restack } from "./restack";
import { undo } from "./undo";

let dir: string;
let cleanup: () => Promise<void>;

beforeEach(async () => {
	const repo = await createTestRepo();
	dir = repo.dir;
	cleanup = repo.cleanup;
	await init(dir);
	await gitInRepo(dir, ["add", "."]);
	await gitInRepo(dir, ["commit", "-m", "init dubstack"]);
});

afterEach(async () => {
	await cleanup();
});

describe("undo", () => {
	it("undoes a create by deleting the branch and restoring state", async () => {
		await create("feat/first", dir);
		expect(await branchExists("feat/first", dir)).toBe(true);

		const result = await undo(dir);

		expect(result.undone).toBe("create");
		expect(await branchExists("feat/first", dir)).toBe(false);
		expect(await getCurrentBranch(dir)).toBe("main");

		const state = await readState(dir);
		expect(state.stacks).toHaveLength(0);
	});

	it("undoes a restack by resetting branch tips", async () => {
		await create("feat/a", dir);
		fs.writeFileSync(path.join(dir, "feat.txt"), "feat");
		await gitInRepo(dir, ["add", "."]);
		await gitInRepo(dir, ["commit", "-m", "feat-commit"]);

		const preTip = await getBranchTip("feat/a", dir);

		await gitInRepo(dir, ["checkout", "main"]);
		fs.writeFileSync(path.join(dir, "base.txt"), "base");
		await gitInRepo(dir, ["add", "."]);
		await gitInRepo(dir, ["commit", "-m", "base-commit"]);
		await gitInRepo(dir, ["checkout", "feat/a"]);

		await restack(dir);
		const postTip = await getBranchTip("feat/a", dir);
		expect(postTip).not.toBe(preTip);

		const result = await undo(dir);

		expect(result.undone).toBe("restack");
		expect(await getBranchTip("feat/a", dir)).toBe(preTip);
	});

	it("throws when nothing to undo", async () => {
		await expect(undo(dir)).rejects.toThrow(DubError);
		await expect(undo(dir)).rejects.toThrow("Nothing to undo");
	});

	it("throws on dirty working tree", async () => {
		await create("feat/first", dir);
		fs.writeFileSync(path.join(dir, "dirty.txt"), "dirty");

		await expect(undo(dir)).rejects.toThrow("uncommitted changes");
	});

	it("clears undo entry after undoing", async () => {
		await create("feat/first", dir);
		await undo(dir);

		await expect(readUndoEntry(dir)).rejects.toThrow("Nothing to undo");
		await expect(undo(dir)).rejects.toThrow("Nothing to undo");
	});
});
