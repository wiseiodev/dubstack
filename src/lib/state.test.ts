import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestRepo } from "../../test/helpers";
import { DubError } from "./errors";
import {
	addBranchToStack,
	type DubState,
	findStackForBranch,
	initState,
	readState,
	writeState,
} from "./state";

let dir: string;
let cleanup: () => Promise<void>;

beforeEach(async () => {
	const repo = await createTestRepo();
	dir = repo.dir;
	cleanup = repo.cleanup;
});

afterEach(async () => {
	await cleanup();
});

describe("readState", () => {
	it("reads valid state", async () => {
		await initState(dir);
		const state = await readState(dir);
		expect(state).toEqual({ stacks: [] });
	});

	it("throws when state file is missing", async () => {
		await expect(readState(dir)).rejects.toThrow(DubError);
		await expect(readState(dir)).rejects.toThrow("not initialized");
	});

	it("throws with actionable message on corrupt JSON", async () => {
		const dubDir = path.join(dir, ".git", "dubstack");
		fs.mkdirSync(dubDir, { recursive: true });
		fs.writeFileSync(path.join(dubDir, "state.json"), "not json{{{");

		await expect(readState(dir)).rejects.toThrow(DubError);
		await expect(readState(dir)).rejects.toThrow("corrupted");
	});
});

describe("writeState and readState roundtrip", () => {
	it("roundtrips correctly", async () => {
		await initState(dir);
		const state: DubState = {
			stacks: [
				{
					id: "test-id",
					branches: [
						{
							name: "main",
							type: "root",
							parent: null,
							pr_number: null,
							pr_link: null,
						},
						{ name: "feat/a", parent: "main", pr_number: null, pr_link: null },
					],
				},
			],
		};
		await writeState(state, dir);
		const loaded = await readState(dir);
		expect(loaded).toEqual(state);
	});

	it("creates parent directory if missing", async () => {
		const state: DubState = { stacks: [] };
		await writeState(state, dir);
		const loaded = await readState(dir);
		expect(loaded).toEqual(state);
	});
});

describe("initState", () => {
	it("creates state file in a fresh repo", async () => {
		const result = await initState(dir);
		expect(result).toBe("created");
		const state = await readState(dir);
		expect(state).toEqual({ stacks: [] });
	});

	it("is idempotent — returns 'already_exists' on second call", async () => {
		await initState(dir);

		// Seed some data to verify it's not overwritten
		const state: DubState = {
			stacks: [
				{
					id: "keep-me",
					branches: [
						{
							name: "main",
							type: "root",
							parent: null,
							pr_number: null,
							pr_link: null,
						},
					],
				},
			],
		};
		await writeState(state, dir);

		const result = await initState(dir);
		expect(result).toBe("already_exists");

		const loaded = await readState(dir);
		expect(loaded.stacks[0].id).toBe("keep-me");
	});
});

describe("findStackForBranch", () => {
	it("finds the correct stack", () => {
		const state: DubState = {
			stacks: [
				{
					id: "stack-1",
					branches: [
						{
							name: "main",
							type: "root",
							parent: null,
							pr_number: null,
							pr_link: null,
						},
						{ name: "feat/a", parent: "main", pr_number: null, pr_link: null },
					],
				},
			],
		};
		const stack = findStackForBranch(state, "feat/a");
		expect(stack?.id).toBe("stack-1");
	});

	it("returns undefined for unknown branch", () => {
		const state: DubState = { stacks: [] };
		expect(findStackForBranch(state, "unknown")).toBeUndefined();
	});
});

describe("addBranchToStack", () => {
	it("appends child to existing stack when parent is found", () => {
		const state: DubState = {
			stacks: [
				{
					id: "stack-1",
					branches: [
						{
							name: "main",
							type: "root",
							parent: null,
							pr_number: null,
							pr_link: null,
						},
						{ name: "feat/a", parent: "main", pr_number: null, pr_link: null },
					],
				},
			],
		};

		addBranchToStack(state, "feat/b", "feat/a");

		expect(state.stacks).toHaveLength(1);
		expect(state.stacks[0].branches).toHaveLength(3);
		expect(state.stacks[0].branches[2]).toEqual({
			name: "feat/b",
			parent: "feat/a",
			pr_number: null,
			pr_link: null,
		});
	});

	it("creates new stack when parent is not in any stack", () => {
		const state: DubState = { stacks: [] };

		addBranchToStack(state, "feat/a", "main");

		expect(state.stacks).toHaveLength(1);
		expect(state.stacks[0].branches).toHaveLength(2);
		expect(state.stacks[0].branches[0]).toMatchObject({
			name: "main",
			type: "root",
			parent: null,
		});
		expect(state.stacks[0].branches[1]).toMatchObject({
			name: "feat/a",
			parent: "main",
		});
	});

	it("throws when child already exists in a stack", () => {
		const state: DubState = {
			stacks: [
				{
					id: "stack-1",
					branches: [
						{
							name: "main",
							type: "root",
							parent: null,
							pr_number: null,
							pr_link: null,
						},
						{ name: "feat/a", parent: "main", pr_number: null, pr_link: null },
					],
				},
			],
		};

		expect(() => addBranchToStack(state, "feat/a", "main")).toThrow(DubError);
		expect(() => addBranchToStack(state, "feat/a", "main")).toThrow(
			"already tracked",
		);
	});
});
