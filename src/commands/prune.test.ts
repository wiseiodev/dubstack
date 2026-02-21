import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/git.js", () => ({
	branchExists: vi.fn(),
	fetchBranches: vi.fn(),
	getCurrentBranch: vi.fn(),
	remoteBranchExists: vi.fn(),
}));

vi.mock("../lib/state.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/state.js")>();
	return {
		...actual,
		readState: vi.fn(),
		writeState: vi.fn(),
	};
});

import {
	branchExists,
	fetchBranches,
	getCurrentBranch,
	remoteBranchExists,
} from "../lib/git";
import type { DubState } from "../lib/state";
import { readState, writeState } from "../lib/state";
import { prune } from "./prune";

const mockBranchExists = branchExists as ReturnType<typeof vi.fn>;
const mockFetchBranches = fetchBranches as ReturnType<typeof vi.fn>;
const mockGetCurrentBranch = getCurrentBranch as ReturnType<typeof vi.fn>;
const mockRemoteBranchExists = remoteBranchExists as ReturnType<typeof vi.fn>;
const mockReadState = readState as ReturnType<typeof vi.fn>;
const mockWriteState = writeState as ReturnType<typeof vi.fn>;

function makeState(
	stacks: Array<{
		id: string;
		branches: { name: string; parent: string | null; type?: "root" }[];
	}>,
): DubState {
	return {
		stacks: stacks.map((stack) => ({
			id: stack.id,
			branches: stack.branches.map((branch) => ({
				...branch,
				pr_number: null,
				pr_link: null,
			})),
		})),
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mockGetCurrentBranch.mockResolvedValue("feat/a");
	mockFetchBranches.mockResolvedValue(undefined);
	mockBranchExists.mockResolvedValue(true);
	mockRemoteBranchExists.mockResolvedValue(true);
	mockWriteState.mockResolvedValue(undefined);
});

describe("prune", () => {
	it("previews stale tracked branches without mutating state", async () => {
		mockReadState.mockResolvedValue(
			makeState([
				{
					id: "stack-1",
					branches: [
						{ name: "main", parent: null, type: "root" },
						{ name: "feat/a", parent: "main" },
					],
				},
			]),
		);
		mockBranchExists.mockResolvedValue(false);
		mockRemoteBranchExists.mockResolvedValue(false);

		const result = await prune("/repo");
		expect(result.applied).toBe(false);
		expect(result.stale).toEqual([
			{
				branch: "feat/a",
				hasLocal: false,
				hasRemote: false,
				reason: "missing-both",
			},
		]);
		expect(result.removed).toEqual([]);
		expect(mockWriteState).not.toHaveBeenCalled();
	});

	it("applies pruning and reparents descendants", async () => {
		mockReadState.mockResolvedValue(
			makeState([
				{
					id: "stack-1",
					branches: [
						{ name: "main", parent: null, type: "root" },
						{ name: "feat/a", parent: "main" },
						{ name: "feat/b", parent: "feat/a" },
					],
				},
			]),
		);
		mockBranchExists.mockImplementation(
			async (name: string) => name !== "feat/a",
		);
		mockRemoteBranchExists.mockImplementation(
			async (name: string) => name !== "feat/a",
		);

		const result = await prune("/repo", { apply: true });
		expect(result.applied).toBe(true);
		expect(result.removed).toEqual(["feat/a"]);

		const saved = mockWriteState.mock.calls[0][0] as DubState;
		const child = saved.stacks[0].branches.find((b) => b.name === "feat/b");
		expect(child?.parent).toBe("main");
	});

	it("scans all stacks when --all is set", async () => {
		mockReadState.mockResolvedValue(
			makeState([
				{
					id: "stack-1",
					branches: [
						{ name: "main", parent: null, type: "root" },
						{ name: "feat/a", parent: "main" },
					],
				},
				{
					id: "stack-2",
					branches: [
						{ name: "develop", parent: null, type: "root" },
						{ name: "chore/x", parent: "develop" },
					],
				},
			]),
		);
		mockBranchExists.mockImplementation(
			async (name: string) => name !== "chore/x",
		);
		mockRemoteBranchExists.mockImplementation(
			async (name: string) => name !== "chore/x",
		);

		const result = await prune("/repo", { all: true });
		expect(result.stale.map((entry) => entry.branch)).toContain("chore/x");
	});
});
