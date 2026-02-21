import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/github.js", () => ({
	checkGhAuth: vi.fn(),
	ensureGhInstalled: vi.fn(),
	getPr: vi.fn(),
	mergePr: vi.fn(),
}));

vi.mock("./post-merge.js", () => ({
	postMerge: vi.fn(),
}));

vi.mock("./submit.js", () => ({
	getSubmitPlan: vi.fn(),
}));

import { checkGhAuth, ensureGhInstalled, getPr, mergePr } from "../lib/github";
import { mergeNext } from "./merge-next";
import { postMerge } from "./post-merge";
import { getSubmitPlan } from "./submit";

const mockEnsureGhInstalled = ensureGhInstalled as ReturnType<typeof vi.fn>;
const mockCheckGhAuth = checkGhAuth as ReturnType<typeof vi.fn>;
const mockGetPr = getPr as ReturnType<typeof vi.fn>;
const mockMergePr = mergePr as ReturnType<typeof vi.fn>;
const mockPostMerge = postMerge as ReturnType<typeof vi.fn>;
const mockGetSubmitPlan = getSubmitPlan as ReturnType<typeof vi.fn>;

beforeEach(() => {
	vi.clearAllMocks();
	mockEnsureGhInstalled.mockResolvedValue(undefined);
	mockCheckGhAuth.mockResolvedValue(undefined);
	mockGetSubmitPlan.mockResolvedValue({
		currentBranch: "feat/c",
		rootBranch: "main",
		path: "current",
		branches: [
			{ name: "feat/a", parent: "main", pr_number: null, pr_link: null },
			{ name: "feat/b", parent: "feat/a", pr_number: null, pr_link: null },
			{ name: "feat/c", parent: "feat/b", pr_number: null, pr_link: null },
		],
		fallbackApplied: false,
	});
	mockGetPr.mockResolvedValue({
		number: 101,
		url: "https://github.com/o/r/pull/101",
		title: "feat: a",
		body: "",
	});
	mockMergePr.mockResolvedValue(undefined);
	mockPostMerge.mockResolvedValue({
		cleaned: ["feat/a"],
		reparented: [{ branch: "feat/b", parent: "main" }],
		retargeted: ["feat/b"],
		restacked: true,
		submitted: true,
		submittedBranches: ["feat/b", "feat/c"],
		dryRun: false,
	});
});

describe("mergeNext", () => {
	it("merges the next safe branch and runs post-merge maintenance", async () => {
		const result = await mergeNext("/repo");

		expect(mockMergePr).toHaveBeenCalledWith(101, "/repo", {
			method: "merge",
			deleteBranch: true,
		});
		expect(mockPostMerge).toHaveBeenCalledWith("/repo", {
			dryRun: false,
			restack: true,
			submit: true,
		});
		expect(result.mergedBranch).toBe("feat/a");
		expect(result.prNumber).toBe(101);
	});

	it("supports dry-run without merging", async () => {
		const result = await mergeNext("/repo", { dryRun: true });

		expect(mockMergePr).not.toHaveBeenCalled();
		expect(mockPostMerge).not.toHaveBeenCalled();
		expect(result.dryRun).toBe(true);
		expect(result.mergedBranch).toBe("feat/a");
	});

	it("throws when next branch has no open PR", async () => {
		mockGetPr.mockResolvedValue(null);
		await expect(mergeNext("/repo")).rejects.toThrow("No open PR found");
	});
});
