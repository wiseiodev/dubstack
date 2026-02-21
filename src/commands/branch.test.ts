import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestRepo, gitInRepo } from "../../test/helpers";
import { branchInfo, formatBranchInfo } from "./branch";
import { create } from "./create";
import { init } from "./init";

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

describe("branch info", () => {
	it("returns tracked metadata for the current branch", async () => {
		await create("feat/a", dir);
		await create("feat/b", dir);

		const info = await branchInfo(dir);
		expect(info).toMatchObject({
			currentBranch: "feat/b",
			tracked: true,
			root: "main",
			parent: "feat/a",
			children: [],
		});
		expect(info.stackId).toBeTruthy();
	});

	it("lists sorted children for tracked branch", async () => {
		await create("feat/a", dir);
		await gitInRepo(dir, ["checkout", "main"]);
		await create("feat/c", dir);
		await gitInRepo(dir, ["checkout", "main"]);
		await create("feat/b", dir);
		await gitInRepo(dir, ["checkout", "main"]);

		const info = await branchInfo(dir);
		expect(info.children).toEqual(["feat/a", "feat/b", "feat/c"]);
	});

	it("returns untracked metadata for a branch outside dubstack state", async () => {
		await gitInRepo(dir, ["checkout", "-b", "rogue"]);

		const info = await branchInfo(dir);
		expect(info).toEqual({
			currentBranch: "rogue",
			tracked: false,
			stackId: null,
			root: null,
			parent: null,
			children: [],
		});
	});

	it("returns metadata for explicitly requested branch", async () => {
		await create("feat/a", dir);
		await create("feat/b", dir);
		await gitInRepo(dir, ["checkout", "feat/b"]);

		const info = await branchInfo(dir, "feat/a");
		expect(info).toMatchObject({
			currentBranch: "feat/a",
			tracked: true,
			parent: "main",
			children: ["feat/b"],
		});
	});

	it("formats tracked and untracked output for CLI display", () => {
		const tracked = formatBranchInfo({
			currentBranch: "feat/a",
			tracked: true,
			stackId: "stack-1",
			root: "main",
			parent: "main",
			children: ["feat/b"],
		});
		expect(tracked).toContain("Branch: feat/a");
		expect(tracked).toContain("Tracked: yes");
		expect(tracked).toContain("Children: feat/b");

		const untracked = formatBranchInfo({
			currentBranch: "rogue",
			tracked: false,
			stackId: null,
			root: null,
			parent: null,
			children: [],
		});
		expect(untracked).toContain("Tracked: no");
		expect(untracked).toContain("not tracked by DubStack");
	});
});
