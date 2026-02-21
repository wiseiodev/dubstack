import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestRepo, gitInRepo } from "../../test/helpers";
import { type DubState, initState, writeState } from "../lib/state";
import { log } from "./log";

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

describe("log", () => {
	it("renders a linear chain with current branch highlighted", async () => {
		// Create branches in git so branchExists returns true
		await gitInRepo(dir, ["checkout", "-b", "feat/a"]);
		await gitInRepo(dir, ["checkout", "-b", "feat/b"]);

		const state: DubState = {
			stacks: [
				{
					id: "stack-1",
					branches: [
						{ name: "main", type: "root", parent: null, pr_link: null },
						{ name: "feat/a", parent: "main", pr_link: null },
						{ name: "feat/b", parent: "feat/a", pr_link: null },
					],
				},
			],
		};
		await writeState(state, dir);

		// Currently on feat/b
		const output = await log(dir);
		expect(output).toBe("(main)\n  └─ feat/a\n       └─ *feat/b (Current)*");
	});

	it("renders branching with correct connectors", async () => {
		await gitInRepo(dir, ["checkout", "-b", "feat/a"]);
		await gitInRepo(dir, ["checkout", "main"]);
		await gitInRepo(dir, ["checkout", "-b", "feat/b"]);

		const state: DubState = {
			stacks: [
				{
					id: "stack-1",
					branches: [
						{ name: "main", type: "root", parent: null, pr_link: null },
						{ name: "feat/a", parent: "main", pr_link: null },
						{ name: "feat/b", parent: "main", pr_link: null },
					],
				},
			],
		};
		await writeState(state, dir);

		// Currently on feat/b
		const output = await log(dir);
		expect(output).toContain("├─ feat/a");
		expect(output).toContain("└─ *feat/b (Current)*");
	});

	it("returns message for empty state", async () => {
		const output = await log(dir);
		expect(output).toBe("No stacks. Run 'dub create' to start.");
	});

	it("renders multiple stacks separated by blank line", async () => {
		await gitInRepo(dir, ["checkout", "-b", "feat/a"]);
		await gitInRepo(dir, ["checkout", "main"]);
		await gitInRepo(dir, ["checkout", "-b", "feat/b"]);

		const state: DubState = {
			stacks: [
				{
					id: "stack-1",
					branches: [
						{ name: "main", type: "root", parent: null, pr_link: null },
						{ name: "feat/a", parent: "main", pr_link: null },
					],
				},
				{
					id: "stack-2",
					branches: [
						{ name: "main", type: "root", parent: null, pr_link: null },
						{ name: "feat/b", parent: "main", pr_link: null },
					],
				},
			],
		};
		await writeState(state, dir);

		const output = await log(dir);
		expect(output).toContain("\n\n");
	});

	it("marks branches that are missing from git", async () => {
		const state: DubState = {
			stacks: [
				{
					id: "stack-1",
					branches: [
						{ name: "main", type: "root", parent: null, pr_link: null },
						{ name: "feat/deleted", parent: "main", pr_link: null },
					],
				},
			],
		};
		await writeState(state, dir);

		const output = await log(dir);
		expect(output).toContain("feat/deleted ⚠ (missing)");
	});

	it("supports --stack mode to show only current stack", async () => {
		await gitInRepo(dir, ["checkout", "-b", "feat/a"]);
		await gitInRepo(dir, ["checkout", "main"]);
		await gitInRepo(dir, ["checkout", "-b", "feat/b"]);

		const state: DubState = {
			stacks: [
				{
					id: "stack-1",
					branches: [
						{ name: "main", type: "root", parent: null, pr_link: null },
						{ name: "feat/a", parent: "main", pr_link: null },
					],
				},
				{
					id: "stack-2",
					branches: [
						{ name: "main", type: "root", parent: null, pr_link: null },
						{ name: "feat/b", parent: "main", pr_link: null },
					],
				},
			],
		};
		await writeState(state, dir);
		await gitInRepo(dir, ["checkout", "feat/b"]);

		const output = await log(dir, { stack: true });
		expect(output).toContain("feat/b");
		expect(output).not.toContain("feat/a");
	});

	it("supports --all mode to show all stacks", async () => {
		await gitInRepo(dir, ["checkout", "-b", "feat/a"]);
		await gitInRepo(dir, ["checkout", "main"]);
		await gitInRepo(dir, ["checkout", "-b", "feat/b"]);

		const state: DubState = {
			stacks: [
				{
					id: "stack-1",
					branches: [
						{ name: "main", type: "root", parent: null, pr_link: null },
						{ name: "feat/a", parent: "main", pr_link: null },
					],
				},
				{
					id: "stack-2",
					branches: [
						{ name: "main", type: "root", parent: null, pr_link: null },
						{ name: "feat/b", parent: "main", pr_link: null },
					],
				},
			],
		};
		await writeState(state, dir);

		const output = await log(dir, { all: true });
		expect(output).toContain("feat/a");
		expect(output).toContain("feat/b");
	});

	it("supports --reverse mode for child ordering", async () => {
		await gitInRepo(dir, ["checkout", "-b", "feat/a"]);
		await gitInRepo(dir, ["checkout", "main"]);
		await gitInRepo(dir, ["checkout", "-b", "feat/b"]);
		await gitInRepo(dir, ["checkout", "main"]);
		await gitInRepo(dir, ["checkout", "-b", "feat/c"]);

		const state: DubState = {
			stacks: [
				{
					id: "stack-1",
					branches: [
						{ name: "main", type: "root", parent: null, pr_link: null },
						{ name: "feat/a", parent: "main", pr_link: null },
						{ name: "feat/b", parent: "main", pr_link: null },
						{ name: "feat/c", parent: "main", pr_link: null },
					],
				},
			],
		};
		await writeState(state, dir);

		const output = await log(dir, { reverse: true });
		expect(output.indexOf("feat/c")).toBeLessThan(output.indexOf("feat/a"));
	});
});
