import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/git.js", () => ({
	branchExists: vi.fn(),
	checkoutBranch: vi.fn(),
	checkoutRemoteBranch: vi.fn(),
	deleteBranch: vi.fn(),
	fastForwardBranchToRef: vi.fn(),
	fetchBranches: vi.fn(),
	getCurrentBranch: vi.fn(),
	getRefSha: vi.fn(),
	hardResetBranchToRef: vi.fn(),
	isAncestor: vi.fn(),
	remoteBranchExists: vi.fn(),
}));

vi.mock("../lib/state.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/state.js")>();
	return {
		...actual,
		readState: vi.fn(),
	};
});

vi.mock("./restack.js", () => ({
	restack: vi.fn(),
}));

vi.mock("../lib/github.js", () => ({
	getBranchPrLifecycleState: vi.fn(),
}));

import {
	branchExists,
	checkoutBranch,
	checkoutRemoteBranch,
	deleteBranch,
	fastForwardBranchToRef,
	fetchBranches,
	getCurrentBranch,
	getRefSha,
	hardResetBranchToRef,
	isAncestor,
	remoteBranchExists,
} from "../lib/git";
import { getBranchPrLifecycleState } from "../lib/github";
import type { DubState } from "../lib/state";
import { readState } from "../lib/state";
import { restack } from "./restack";
import { sync } from "./sync";

const mockBranchExists = branchExists as ReturnType<typeof vi.fn>;
const mockCheckoutBranch = checkoutBranch as ReturnType<typeof vi.fn>;
const mockCheckoutRemoteBranch = checkoutRemoteBranch as ReturnType<
	typeof vi.fn
>;
const mockDeleteBranch = deleteBranch as ReturnType<typeof vi.fn>;
const mockFastForwardBranchToRef = fastForwardBranchToRef as ReturnType<
	typeof vi.fn
>;
const mockFetchBranches = fetchBranches as ReturnType<typeof vi.fn>;
const mockGetCurrentBranch = getCurrentBranch as ReturnType<typeof vi.fn>;
const mockGetRefSha = getRefSha as ReturnType<typeof vi.fn>;
const mockHardResetBranchToRef = hardResetBranchToRef as ReturnType<
	typeof vi.fn
>;
const mockIsAncestor = isAncestor as ReturnType<typeof vi.fn>;
const mockRemoteBranchExists = remoteBranchExists as ReturnType<typeof vi.fn>;
const mockReadState = readState as ReturnType<typeof vi.fn>;
const mockRestack = restack as ReturnType<typeof vi.fn>;
const mockGetBranchPrLifecycleState = getBranchPrLifecycleState as ReturnType<
	typeof vi.fn
>;

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
	mockFetchBranches.mockResolvedValue(undefined);
	mockFastForwardBranchToRef.mockResolvedValue(true);
	mockBranchExists.mockResolvedValue(true);
	mockRemoteBranchExists.mockResolvedValue(true);
	mockGetRefSha.mockImplementation(async (ref: string) => `${ref}-sha`);
	mockIsAncestor.mockResolvedValue(false);
	mockHardResetBranchToRef.mockResolvedValue(undefined);
	mockCheckoutRemoteBranch.mockResolvedValue(undefined);
	mockCheckoutBranch.mockResolvedValue(undefined);
	mockDeleteBranch.mockResolvedValue(undefined);
	mockRestack.mockResolvedValue({ status: "up-to-date", rebased: [] });
	mockGetBranchPrLifecycleState.mockResolvedValue("OPEN");
});

describe("sync", () => {
	it("throws when current branch is not tracked and --all is false", async () => {
		mockReadState.mockResolvedValue({ stacks: [] });
		await expect(sync("/repo", { interactive: false })).rejects.toThrow(
			"not part of any stack",
		);
	});

	it("fetches tracked branches and reports up-to-date branch", async () => {
		mockReadState.mockResolvedValue(
			makeState([
				{ name: "main", parent: null, type: "root" },
				{ name: "feat/a", parent: "main" },
			]),
		);
		mockGetRefSha.mockResolvedValue("same-sha");

		const result = await sync("/repo", { interactive: false, restack: false });

		expect(mockFetchBranches).toHaveBeenCalledWith(["main", "feat/a"], "/repo");
		expect(result.fetched).toEqual(["main", "feat/a"]);
		expect(result.branches[0].status).toBe("up-to-date");
		expect(mockRestack).not.toHaveBeenCalled();
	});

	it("restores missing local branch from remote", async () => {
		mockReadState.mockResolvedValue(
			makeState([
				{ name: "main", parent: null, type: "root" },
				{ name: "feat/a", parent: "main" },
			]),
		);
		mockBranchExists.mockImplementation(
			async (name: string) => name === "main",
		);
		mockGetRefSha.mockResolvedValue("same-sha");

		const result = await sync("/repo", { interactive: false, restack: false });

		expect(mockCheckoutRemoteBranch).toHaveBeenCalledWith("feat/a", "/repo");
		expect(result.branches[0].status).toBe("missing-local");
	});

	it("hard-resets branch when local is safely behind remote", async () => {
		mockReadState.mockResolvedValue(
			makeState([
				{ name: "main", parent: null, type: "root" },
				{ name: "feat/a", parent: "main" },
			]),
		);
		mockGetRefSha
			.mockResolvedValueOnce("local-a")
			.mockResolvedValueOnce("remote-a");
		mockIsAncestor
			.mockResolvedValueOnce(true) // local behind remote
			.mockResolvedValueOnce(false);

		const result = await sync("/repo", { interactive: false, restack: false });

		expect(mockHardResetBranchToRef).toHaveBeenCalledWith(
			"feat/a",
			"origin/feat/a",
			"/repo",
		);
		expect(result.branches[0].status).toBe("needs-remote-sync-safe");
	});

	it("skips diverged branch in non-interactive mode without force", async () => {
		mockReadState.mockResolvedValue(
			makeState([
				{ name: "main", parent: null, type: "root" },
				{ name: "feat/a", parent: "main" },
			]),
		);
		mockGetRefSha
			.mockResolvedValueOnce("local-a")
			.mockResolvedValueOnce("remote-a");
		mockIsAncestor.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

		const result = await sync("/repo", { interactive: false, restack: false });

		expect(result.branches[0].status).toBe("reconcile-needed");
		expect(result.branches[0].action).toBe("skipped");
		expect(mockHardResetBranchToRef).not.toHaveBeenCalled();
	});

	it("forces diverged branch to remote with --force", async () => {
		mockReadState.mockResolvedValue(
			makeState([
				{ name: "main", parent: null, type: "root" },
				{ name: "feat/a", parent: "main" },
			]),
		);
		mockGetRefSha
			.mockResolvedValueOnce("local-a")
			.mockResolvedValueOnce("remote-a");
		mockIsAncestor.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

		const result = await sync("/repo", {
			interactive: false,
			force: true,
			restack: false,
		});

		expect(result.branches[0].action).toBe("synced");
		expect(mockHardResetBranchToRef).toHaveBeenCalledWith(
			"feat/a",
			"origin/feat/a",
			"/repo",
		);
	});
});
