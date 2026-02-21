import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/git.js", () => ({
	branchExists: vi.fn(),
	fetchBranches: vi.fn(),
	getCurrentBranch: vi.fn(),
	getRefSha: vi.fn(),
	remoteBranchExists: vi.fn(),
}));

vi.mock("../lib/operation-state.js", () => ({
	detectActiveOperation: vi.fn(),
}));

vi.mock("../lib/state.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/state.js")>();
	return {
		...actual,
		readState: vi.fn(),
	};
});

import {
	branchExists,
	fetchBranches,
	getCurrentBranch,
	getRefSha,
	remoteBranchExists,
} from "../lib/git";
import { detectActiveOperation } from "../lib/operation-state";
import type { DubState } from "../lib/state";
import { readState } from "../lib/state";
import { doctor } from "./doctor";

const mockBranchExists = branchExists as ReturnType<typeof vi.fn>;
const mockFetchBranches = fetchBranches as ReturnType<typeof vi.fn>;
const mockGetCurrentBranch = getCurrentBranch as ReturnType<typeof vi.fn>;
const mockGetRefSha = getRefSha as ReturnType<typeof vi.fn>;
const mockRemoteBranchExists = remoteBranchExists as ReturnType<typeof vi.fn>;
const mockDetectActiveOperation = detectActiveOperation as ReturnType<
	typeof vi.fn
>;
const mockReadState = readState as ReturnType<typeof vi.fn>;

function makeState(
	branches: { name: string; parent: string | null; type?: "root" }[],
): DubState {
	return {
		stacks: [
			{
				id: "stack-1",
				branches: branches.map((b) => ({
					...b,
					pr_number: null,
					pr_link: null,
				})),
			},
		],
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mockGetCurrentBranch.mockResolvedValue("feat/a");
	mockDetectActiveOperation.mockResolvedValue("none");
	mockFetchBranches.mockResolvedValue(undefined);
	mockBranchExists.mockResolvedValue(true);
	mockRemoteBranchExists.mockResolvedValue(true);
	mockGetRefSha.mockImplementation(async (ref: string) => `${ref}-sha`);
});

describe("doctor", () => {
	it("reports a clean bill of health for a linear synced path", async () => {
		mockReadState.mockResolvedValue(
			makeState([
				{ name: "main", parent: null, type: "root" },
				{ name: "feat/a", parent: "main" },
			]),
		);
		mockGetRefSha.mockResolvedValue("same-sha");

		const result = await doctor("/repo");
		expect(result.healthy).toBe(true);
		expect(result.issues).toEqual([]);
	});

	it("detects active operations, missing tracked branches, and drift", async () => {
		mockReadState.mockResolvedValue(
			makeState([
				{ name: "main", parent: null, type: "root" },
				{ name: "feat/a", parent: "main" },
				{ name: "feat/b", parent: "feat/a" },
			]),
		);
		mockDetectActiveOperation.mockResolvedValue("restack");
		mockBranchExists.mockImplementation(
			async (name: string) => name !== "feat/b",
		);
		mockRemoteBranchExists.mockResolvedValue(true);
		mockGetRefSha
			.mockResolvedValueOnce("local-a")
			.mockResolvedValueOnce("remote-a")
			.mockResolvedValueOnce("same-sha")
			.mockResolvedValueOnce("same-sha");

		const result = await doctor("/repo");
		const codes = result.issues.map((issue) => issue.code);
		expect(codes).toContain("operation-in-progress");
		expect(codes).toContain("missing-local");
		expect(codes).toContain("remote-drift");
		expect(result.healthy).toBe(false);
	});

	it("detects submit branching blockers with explicit parent and children", async () => {
		mockReadState.mockResolvedValue(
			makeState([
				{ name: "main", parent: null, type: "root" },
				{ name: "feat/a", parent: "main" },
				{ name: "feat/b", parent: "main" },
			]),
		);
		mockGetRefSha.mockResolvedValue("same-sha");

		const result = await doctor("/repo");
		const branching = result.issues.find(
			(issue) => issue.code === "submit-branching-blocker",
		);
		expect(branching?.details).toContain("main -> feat/a, feat/b");
	});
});
