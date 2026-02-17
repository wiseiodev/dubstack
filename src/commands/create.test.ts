import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestRepo, gitInRepo } from "../../test/helpers.js";
import { DubError } from "../lib/errors.js";
import { getCurrentBranch } from "../lib/git.js";
import { readState } from "../lib/state.js";
import { readUndoEntry } from "../lib/undo-log.js";
import { create } from "./create.js";
import { init } from "./init.js";

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

describe("create", () => {
	it("creates a branch from main and updates state", async () => {
		const result = await create("feat/first", dir);

		expect(result.branch).toBe("feat/first");
		expect(result.parent).toBe("main");
		expect(await getCurrentBranch(dir)).toBe("feat/first");

		const state = await readState(dir);
		expect(state.stacks).toHaveLength(1);
		expect(state.stacks[0].branches).toHaveLength(2);
		expect(state.stacks[0].branches[0]).toMatchObject({
			name: "main",
			type: "root",
		});
		expect(state.stacks[0].branches[1]).toMatchObject({
			name: "feat/first",
			parent: "main",
		});
	});

	it("creates a 3-deep chain in the same stack", async () => {
		await create("feat/first", dir);
		await create("feat/second", dir);

		const state = await readState(dir);
		expect(state.stacks).toHaveLength(1);
		expect(state.stacks[0].branches).toHaveLength(3);
		expect(state.stacks[0].branches[2]).toMatchObject({
			name: "feat/second",
			parent: "feat/first",
		});
	});

	it("throws when branch already exists in git", async () => {
		await gitInRepo(dir, ["checkout", "-b", "existing"]);
		await gitInRepo(dir, ["checkout", "main"]);

		await expect(create("existing", dir)).rejects.toThrow(DubError);
		await expect(create("existing", dir)).rejects.toThrow("already exists");

		// State should be unchanged
		const state = await readState(dir);
		expect(state.stacks).toHaveLength(0);
	});

	it("throws when not initialized", async () => {
		const repo2 = await createTestRepo();
		try {
			await expect(create("feat/x", repo2.dir)).rejects.toThrow(
				"not initialized",
			);
		} finally {
			await repo2.cleanup();
		}
	});

	it("saves an undo entry", async () => {
		await create("feat/first", dir);

		const entry = await readUndoEntry(dir);
		expect(entry.operation).toBe("create");
		expect(entry.previousBranch).toBe("main");
		expect(entry.createdBranches).toEqual(["feat/first"]);
		expect(entry.previousState.stacks).toHaveLength(0);
	});
});
