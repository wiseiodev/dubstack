import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestRepo, gitInRepo } from "../../test/helpers";
import { getCurrentBranch } from "../lib/git";
import { create } from "./create";
import { init } from "./init";
import { bottom, down, downBySteps, top, up, upBySteps } from "./navigate";

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

describe("navigate", () => {
	it("moves up and down in a linear stack", async () => {
		await create("feat/a", dir);
		await create("feat/b", dir);
		await gitInRepo(dir, ["checkout", "feat/a"]);

		const upResult = await up(dir);
		expect(upResult.branch).toBe("feat/b");
		expect(await getCurrentBranch(dir)).toBe("feat/b");

		const downResult = await down(dir);
		expect(downResult.branch).toBe("feat/a");
		expect(await getCurrentBranch(dir)).toBe("feat/a");
	});

	it("moves multiple steps with upBySteps/downBySteps", async () => {
		await create("feat/a", dir);
		await create("feat/b", dir);
		await create("feat/c", dir);
		await gitInRepo(dir, ["checkout", "feat/a"]);

		const upResult = await upBySteps(dir, 2);
		expect(upResult.branch).toBe("feat/c");
		expect(await getCurrentBranch(dir)).toBe("feat/c");

		const downResult = await downBySteps(dir, 2);
		expect(downResult.branch).toBe("feat/a");
		expect(await getCurrentBranch(dir)).toBe("feat/a");
	});

	it("returns unchanged when already at top", async () => {
		await create("feat/a", dir);

		const result = await top(dir);
		expect(result.branch).toBe("feat/a");
		expect(result.changed).toBe(false);
	});

	it("moves to top descendant in a linear stack", async () => {
		await create("feat/a", dir);
		await create("feat/b", dir);
		await create("feat/c", dir);
		await gitInRepo(dir, ["checkout", "main"]);

		const result = await top(dir);
		expect(result.branch).toBe("feat/c");
		expect(await getCurrentBranch(dir)).toBe("feat/c");
	});

	it("moves to first branch above root from deep in stack", async () => {
		await create("feat/a", dir);
		await create("feat/b", dir);
		await create("feat/c", dir);

		const result = await bottom(dir);
		expect(result.branch).toBe("feat/a");
		expect(await getCurrentBranch(dir)).toBe("feat/a");
	});

	it("moves from root to first branch above root", async () => {
		await create("feat/a", dir);
		await gitInRepo(dir, ["checkout", "main"]);

		const result = await bottom(dir);
		expect(result.branch).toBe("feat/a");
		expect(await getCurrentBranch(dir)).toBe("feat/a");
	});

	it("throws for up when there is no child", async () => {
		await create("feat/a", dir);

		await expect(up(dir)).rejects.toThrow("No branch above 'feat/a'");
	});

	it("throws for down when already at root", async () => {
		await create("feat/a", dir);
		await gitInRepo(dir, ["checkout", "main"]);

		await expect(down(dir)).rejects.toThrow("Already at the bottom");
	});

	it("throws for non-positive step counts", async () => {
		await create("feat/a", dir);
		await expect(upBySteps(dir, 0)).rejects.toThrow("positive integer");
		await expect(downBySteps(dir, -1)).rejects.toThrow("positive integer");
	});

	it("throws for top when path is non-linear", async () => {
		await create("feat/a", dir);
		await gitInRepo(dir, ["checkout", "main"]);
		await create("feat/b", dir);
		await gitInRepo(dir, ["checkout", "main"]);

		await expect(top(dir)).rejects.toThrow("requires a linear stack path");
	});

	it("throws for up when current branch has multiple children", async () => {
		await create("feat/a", dir);
		await gitInRepo(dir, ["checkout", "main"]);
		await create("feat/b", dir);
		await gitInRepo(dir, ["checkout", "main"]);

		await expect(up(dir)).rejects.toThrow("requires a linear stack path");
	});

	it("throws for bottom on root when root has multiple children", async () => {
		await create("feat/a", dir);
		await gitInRepo(dir, ["checkout", "main"]);
		await create("feat/b", dir);
		await gitInRepo(dir, ["checkout", "main"]);

		await expect(bottom(dir)).rejects.toThrow("requires a linear stack path");
	});
});
