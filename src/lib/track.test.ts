import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestRepo, gitInRepo } from "../../test/helpers";
import { initState, readState } from "./state";
import { trackBranch, validateTrackParent } from "./track";

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

describe("validateTrackParent", () => {
	it("rejects an invalid parent branch", async () => {
		await gitInRepo(dir, ["checkout", "-b", "feat/a"]);

		await expect(
			validateTrackParent(dir, "feat/a", "missing/parent"),
		).rejects.toThrow("Parent branch");
	});
});

describe("trackBranch", () => {
	it("tracks an untracked branch under a valid parent", async () => {
		await gitInRepo(dir, ["checkout", "-b", "feat/a"]);

		const result = await trackBranch(dir, {
			branch: "feat/a",
			parent: "main",
		});

		expect(result.status).toBe("tracked");
		const state = await readState(dir);
		const stack = state.stacks.find((entry) =>
			entry.branches.some((branch) => branch.name === "feat/a"),
		);
		expect(stack).toBeDefined();
		expect(
			stack?.branches.find((branch) => branch.name === "feat/a")?.parent,
		).toBe("main");
	});

	it("re-parents an already tracked branch", async () => {
		await gitInRepo(dir, ["checkout", "-b", "feat/a"]);
		await trackBranch(dir, { branch: "feat/a", parent: "main" });

		await gitInRepo(dir, ["checkout", "main"]);
		await gitInRepo(dir, ["checkout", "-b", "feat/b"]);
		await trackBranch(dir, { branch: "feat/b", parent: "main" });

		const result = await trackBranch(dir, {
			branch: "feat/b",
			parent: "feat/a",
		});

		expect(result.status).toBe("reparented");
		const state = await readState(dir);
		const stack = state.stacks.find((entry) =>
			entry.branches.some((branch) => branch.name === "feat/b"),
		);
		expect(
			stack?.branches.find((branch) => branch.name === "feat/b")?.parent,
		).toBe("feat/a");
	});
});
