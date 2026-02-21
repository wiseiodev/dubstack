import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestRepo, gitInRepo } from "../../test/helpers";
import { getCurrentBranch } from "../lib/git";
import { type DubState, readState } from "../lib/state";
import {
	checkout,
	getStackRelativeBranches,
	getTrackedBranches,
	getValidBranches,
	resolveCheckoutTrunk,
} from "./checkout";
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

describe("checkout", () => {
	it("switches to an existing branch", async () => {
		await create("feat/a", dir);
		await gitInRepo(dir, ["checkout", "main"]);

		const result = await checkout("feat/a", dir);

		expect(result.branch).toBe("feat/a");
		expect(await getCurrentBranch(dir)).toBe("feat/a");
	});

	it("throws when branch does not exist", async () => {
		await expect(checkout("nope", dir)).rejects.toThrow("not found");
	});

	it("resolves tracked trunk for checkout --trunk", async () => {
		await create("feat/a", dir);
		const trunk = await resolveCheckoutTrunk(dir);
		expect(trunk).toBe("main");
	});
});

describe("getTrackedBranches", () => {
	it("returns only tracked branches", async () => {
		await create("feat/a", dir);
		await gitInRepo(dir, ["checkout", "main"]);
		await gitInRepo(dir, ["checkout", "-b", "rogue"]);

		const state = await readState(dir);
		const branches = getTrackedBranches(state);

		expect(branches).toContain("main");
		expect(branches).toContain("feat/a");
		expect(branches).not.toContain("rogue");
	});

	it("deduplicates root branches across stacks", async () => {
		await create("feat/a", dir);
		await gitInRepo(dir, ["checkout", "main"]);
		await create("feat/b", dir);

		const state = await readState(dir);
		const branches = getTrackedBranches(state);
		const mainCount = branches.filter((b) => b === "main").length;

		expect(mainCount).toBe(1);
	});

	it("returns empty array for empty state", async () => {
		const emptyState: DubState = { stacks: [] };
		expect(getTrackedBranches(emptyState)).toEqual([]);
	});

	it("returns branches sorted alphabetically", async () => {
		await create("feat/z", dir);
		await create("feat/a", dir);

		const state = await readState(dir);
		const branches = getTrackedBranches(state);
		const sorted = [...branches].sort();

		expect(branches).toEqual(sorted);
	});
});

describe("getValidBranches", () => {
	it("filters out branches not present in the local list", async () => {
		await create("feat/stale", dir);
		await gitInRepo(dir, ["checkout", "main"]);
		await gitInRepo(dir, ["branch", "-D", "feat/stale"]);

		const state = await readState(dir);
		const tracked = getTrackedBranches(state);
		const { stdout } = await gitInRepo(dir, [
			"branch",
			"--format=%(refname:short)",
		]);
		const local = stdout.trim().split("\n");

		const valid = getValidBranches(tracked, local);

		expect(tracked).toContain("feat/stale");
		expect(local).not.toContain("feat/stale");
		expect(valid).not.toContain("feat/stale");
		expect(valid).toContain("main");
	});

	it("returns empty array if no branches match", () => {
		const tracked = ["feat/a"];
		const local = ["main"];
		expect(getValidBranches(tracked, local)).toEqual([]);
	});
});

describe("getStackRelativeBranches", () => {
	it("returns the current stack branch set", async () => {
		await create("feat/a", dir);
		await create("feat/b", dir);
		await gitInRepo(dir, ["checkout", "feat/a"]);

		const state = await readState(dir);
		expect(getStackRelativeBranches(state, "feat/a")).toEqual([
			"feat/a",
			"feat/b",
			"main",
		]);
	});

	it("returns empty list for untracked branch", async () => {
		const state = await readState(dir);
		expect(getStackRelativeBranches(state, "rogue")).toEqual([]);
	});
});
