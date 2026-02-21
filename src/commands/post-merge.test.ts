import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/git.js", () => ({
	checkoutBranch: vi.fn(),
	getCurrentBranch: vi.fn(),
}));

vi.mock("../lib/state.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/state.js")>();
	return {
		...actual,
		readState: vi.fn(),
		writeState: vi.fn(),
	};
});

vi.mock("../lib/github.js", () => ({
	checkGhAuth: vi.fn(),
	ensureGhInstalled: vi.fn(),
	getBranchPrLifecycleState: vi.fn(),
	getBranchPrSyncInfo: vi.fn(),
	retargetPrBase: vi.fn(),
}));

vi.mock("./restack.js", () => ({
	restack: vi.fn(),
}));

vi.mock("./submit.js", () => ({
	submit: vi.fn(),
}));

import { checkoutBranch, getCurrentBranch } from "../lib/git";
import {
	checkGhAuth,
	ensureGhInstalled,
	getBranchPrLifecycleState,
	getBranchPrSyncInfo,
	retargetPrBase,
} from "../lib/github";
import type { DubState } from "../lib/state";
import { readState, writeState } from "../lib/state";
import { postMerge } from "./post-merge";
import { restack } from "./restack";
import { submit } from "./submit";

const mockCheckoutBranch = checkoutBranch as ReturnType<typeof vi.fn>;
const mockGetCurrentBranch = getCurrentBranch as ReturnType<typeof vi.fn>;
const mockEnsureGhInstalled = ensureGhInstalled as ReturnType<typeof vi.fn>;
const mockCheckGhAuth = checkGhAuth as ReturnType<typeof vi.fn>;
const mockGetBranchPrLifecycleState = getBranchPrLifecycleState as ReturnType<
	typeof vi.fn
>;
const mockGetBranchPrSyncInfo = getBranchPrSyncInfo as ReturnType<typeof vi.fn>;
const mockRetargetPrBase = retargetPrBase as ReturnType<typeof vi.fn>;
const mockReadState = readState as ReturnType<typeof vi.fn>;
const mockWriteState = writeState as ReturnType<typeof vi.fn>;
const mockRestack = restack as ReturnType<typeof vi.fn>;
const mockSubmit = submit as ReturnType<typeof vi.fn>;

function makeState(): DubState {
	return {
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
						pr_number: 1,
						pr_link: "https://x/1",
					},
					{
						name: "feat/b",
						parent: "feat/a",
						pr_number: 2,
						pr_link: "https://x/2",
					},
				],
			},
		],
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mockGetCurrentBranch.mockResolvedValue("feat/b");
	mockEnsureGhInstalled.mockResolvedValue(undefined);
	mockCheckGhAuth.mockResolvedValue(undefined);
	mockReadState.mockResolvedValue(makeState());
	mockWriteState.mockResolvedValue(undefined);
	mockGetBranchPrLifecycleState.mockImplementation(async (branch: string) => {
		if (branch === "feat/a") return "MERGED";
		if (branch === "feat/b") return "OPEN";
		return "NONE";
	});
	mockGetBranchPrSyncInfo.mockImplementation(async (branch: string) => {
		if (branch === "feat/b") {
			return { state: "OPEN", baseRefName: "feat/a" };
		}
		return { state: "NONE", baseRefName: null };
	});
	mockRetargetPrBase.mockResolvedValue(undefined);
	mockRestack.mockResolvedValue({ status: "up-to-date", rebased: [] });
	mockSubmit.mockResolvedValue({
		pushed: ["feat/b"],
		created: [],
		updated: ["feat/b"],
		path: "current",
		dryRun: false,
		fallbackApplied: false,
	});
});

describe("postMerge", () => {
	it("removes merged bottom branches, reparents children, and retargets PR base", async () => {
		const result = await postMerge("/repo", {
			restack: false,
			submit: false,
		});

		expect(result.cleaned).toEqual(["feat/a"]);
		expect(result.retargeted).toEqual(["feat/b"]);
		expect(mockRetargetPrBase).toHaveBeenCalledWith("feat/b", "main", "/repo");
		const saved = mockWriteState.mock.calls[0][0] as DubState;
		const featB = saved.stacks[0].branches.find((b) => b.name === "feat/b");
		expect(featB?.parent).toBe("main");
	});

	it("supports dry-run without mutating state", async () => {
		const result = await postMerge("/repo", {
			dryRun: true,
		});

		expect(result.cleaned).toEqual(["feat/a"]);
		expect(mockWriteState).not.toHaveBeenCalled();
		expect(mockRetargetPrBase).not.toHaveBeenCalled();
		expect(mockRestack).not.toHaveBeenCalled();
		expect(mockSubmit).not.toHaveBeenCalled();
	});

	it("runs restack and submit maintenance by default", async () => {
		await postMerge("/repo");

		expect(mockRestack).toHaveBeenCalled();
		expect(mockSubmit).toHaveBeenCalledWith("/repo", false, {
			path: "current",
			fix: true,
		});
		expect(mockCheckoutBranch).toHaveBeenCalledWith("main", "/repo");
	});

	it("submits each stack when --all is enabled", async () => {
		const allStacksState: DubState = {
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
							pr_number: 1,
							pr_link: "https://x/1",
						},
					],
				},
				{
					id: "stack-2",
					branches: [
						{
							name: "develop",
							type: "root",
							parent: null,
							pr_number: null,
							pr_link: null,
						},
						{
							name: "feat/c",
							parent: "develop",
							pr_number: 3,
							pr_link: "https://x/3",
						},
					],
				},
			],
		};
		mockReadState.mockResolvedValue(allStacksState);
		mockGetBranchPrLifecycleState.mockResolvedValue("OPEN");
		mockGetBranchPrSyncInfo.mockResolvedValue({
			state: "OPEN",
			baseRefName: "main",
		});
		mockSubmit.mockResolvedValue({
			pushed: ["feat/a"],
			created: [],
			updated: ["feat/a"],
			path: "current",
			dryRun: false,
			fallbackApplied: false,
		});

		await postMerge("/repo", { all: true, restack: false, submit: true });

		expect(mockSubmit).toHaveBeenCalledTimes(2);
		expect(mockCheckoutBranch).toHaveBeenCalledWith("feat/a", "/repo");
		expect(mockCheckoutBranch).toHaveBeenCalledWith("feat/c", "/repo");
	});
});
