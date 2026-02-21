import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/github.js", () => ({
	checkGhAuth: vi.fn(),
	ensureGhInstalled: vi.fn(),
	getPr: vi.fn(),
	getPrByNumber: vi.fn(),
	getPrStateByNumber: vi.fn(),
}));

vi.mock("../lib/git.js", () => ({
	getCurrentBranch: vi.fn(),
}));

import { getCurrentBranch } from "../lib/git";
import {
	checkGhAuth,
	ensureGhInstalled,
	getPr,
	getPrByNumber,
	getPrStateByNumber,
} from "../lib/github";
import { mergeCheck } from "./merge-check";

const mockEnsureGhInstalled = ensureGhInstalled as ReturnType<typeof vi.fn>;
const mockCheckGhAuth = checkGhAuth as ReturnType<typeof vi.fn>;
const mockGetPr = getPr as ReturnType<typeof vi.fn>;
const mockGetPrByNumber = getPrByNumber as ReturnType<typeof vi.fn>;
const mockGetPrStateByNumber = getPrStateByNumber as ReturnType<typeof vi.fn>;
const mockGetCurrentBranch = getCurrentBranch as ReturnType<typeof vi.fn>;

beforeEach(() => {
	vi.clearAllMocks();
	mockEnsureGhInstalled.mockResolvedValue(undefined);
	mockCheckGhAuth.mockResolvedValue(undefined);
	mockGetCurrentBranch.mockResolvedValue("feat/a");
	mockGetPr.mockResolvedValue({
		number: 11,
		url: "https://github.com/o/r/pull/11",
		title: "feat: a",
		body: "plain body",
	});
	mockGetPrByNumber.mockResolvedValue({
		number: 11,
		url: "https://github.com/o/r/pull/11",
		title: "feat: a",
		body: "plain body",
	});
	mockGetPrStateByNumber.mockResolvedValue("MERGED");
});

describe("mergeCheck", () => {
	it("passes when PR is not a DubStack PR", async () => {
		const result = await mergeCheck("/repo", { pr: 11 });
		expect(result.ok).toBe(true);
		expect(result.reason).toContain("No DubStack metadata");
	});

	it("passes when previous PR is already merged", async () => {
		mockGetPrByNumber.mockResolvedValue({
			number: 12,
			url: "https://github.com/o/r/pull/12",
			title: "feat: b",
			body: [
				"body",
				"<!-- dubstack-metadata",
				'{ "stack_id":"x","pr_number":12,"prev_pr":11,"next_pr":null,"branch":"feat/b" }',
				"-->",
			].join("\n"),
		});
		mockGetPrStateByNumber.mockResolvedValue("MERGED");

		const result = await mergeCheck("/repo", { pr: 12 });
		expect(result.ok).toBe(true);
		expect(result.reason).toContain("merge order satisfied");
	});

	it("fails when previous PR is not merged yet", async () => {
		mockGetPrByNumber.mockResolvedValue({
			number: 12,
			url: "https://github.com/o/r/pull/12",
			title: "feat: b",
			body: [
				"body",
				"<!-- dubstack-metadata",
				'{ "stack_id":"x","pr_number":12,"prev_pr":11,"next_pr":null,"branch":"feat/b" }',
				"-->",
			].join("\n"),
		});
		mockGetPrStateByNumber.mockResolvedValue("OPEN");

		await expect(mergeCheck("/repo", { pr: 12 })).rejects.toThrow(
			"cannot be merged yet",
		);
	});
});
