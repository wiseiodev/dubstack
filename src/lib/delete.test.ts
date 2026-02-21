import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestRepo } from "../../test/helpers";
import { deleteTrackedBranch } from "./delete";
import { checkoutBranch, deleteLocalBranch, getCurrentBranch } from "./git";
import { initState, readState, writeState } from "./state";

vi.mock("./git", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./git")>();
	return {
		...actual,
		getCurrentBranch: vi.fn(),
		checkoutBranch: vi.fn(),
		deleteLocalBranch: vi.fn(),
	};
});

let dir: string;
let cleanup: () => Promise<void>;

beforeEach(async () => {
	const repo = await createTestRepo();
	dir = repo.dir;
	cleanup = repo.cleanup;
	await initState(dir);
	vi.clearAllMocks();
	vi.mocked(getCurrentBranch).mockResolvedValue("main");
	vi.mocked(checkoutBranch).mockResolvedValue(undefined);
	vi.mocked(deleteLocalBranch).mockResolvedValue(undefined);
});

afterEach(async () => {
	await cleanup();
});

async function seedState() {
	await writeState(
		{
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
						{
							name: "feat/a",
							parent: "main",
							pr_number: null,
							pr_link: null,
						},
						{
							name: "feat/b",
							parent: "feat/a",
							pr_number: null,
							pr_link: null,
						},
						{
							name: "feat/c",
							parent: "feat/b",
							pr_number: null,
							pr_link: null,
						},
					],
				},
			],
		},
		dir,
	);
}

describe("deleteTrackedBranch", () => {
	it("deletes a single branch and re-parents children", async () => {
		await seedState();

		const result = await deleteTrackedBranch(dir, { branch: "feat/b" });

		expect(result.deleted).toEqual(["feat/b"]);
		const state = await readState(dir);
		const featC = state.stacks[0].branches.find(
			(branch) => branch.name === "feat/c",
		);
		expect(featC?.parent).toBe("feat/a");
	});

	it("expands --upstack to include descendants", async () => {
		await seedState();

		const result = await deleteTrackedBranch(dir, {
			branch: "feat/a",
			upstack: true,
		});

		expect(result.deleted).toEqual(["feat/c", "feat/b", "feat/a"]);
		const state = await readState(dir);
		expect(state.stacks[0].branches.map((branch) => branch.name)).toEqual([
			"main",
		]);
	});

	it("expands --downstack to include ancestors", async () => {
		await seedState();

		const result = await deleteTrackedBranch(dir, {
			branch: "feat/c",
			downstack: true,
		});

		expect(result.deleted).toEqual(["feat/c", "feat/b", "feat/a"]);
		const state = await readState(dir);
		expect(state.stacks[0].branches.map((branch) => branch.name)).toEqual([
			"main",
		]);
	});

	it("passes force flag to git deletion", async () => {
		await seedState();

		await deleteTrackedBranch(dir, {
			branch: "feat/c",
			force: true,
		});

		expect(deleteLocalBranch).toHaveBeenCalledWith("feat/c", dir, true);
	});
});
