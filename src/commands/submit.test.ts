import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/git.js", () => ({
	getBranchTip: vi.fn(),
	getCurrentBranch: vi.fn(),
	getLastCommitMessage: vi.fn(),
	pushBranch: vi.fn(),
}));

vi.mock("../lib/github.js", () => ({
	ensureGhInstalled: vi.fn(),
	checkGhAuth: vi.fn(),
	getPr: vi.fn(),
	createPr: vi.fn(),
	updatePrBody: vi.fn(),
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
	getBranchTip,
	getCurrentBranch,
	getLastCommitMessage,
	pushBranch,
} from "../lib/git";
import {
	checkGhAuth,
	createPr,
	ensureGhInstalled,
	getPr,
	updatePrBody,
} from "../lib/github";
import type { DubState } from "../lib/state";
import { readState, writeState } from "../lib/state";
import { submit } from "./submit";

const mockGetCurrentBranch = getCurrentBranch as ReturnType<typeof vi.fn>;
const mockGetBranchTip = getBranchTip as ReturnType<typeof vi.fn>;
const mockGetLastCommitMessage = getLastCommitMessage as ReturnType<
	typeof vi.fn
>;
const mockPushBranch = pushBranch as ReturnType<typeof vi.fn>;
const mockEnsureGhInstalled = ensureGhInstalled as ReturnType<typeof vi.fn>;
const mockCheckGhAuth = checkGhAuth as ReturnType<typeof vi.fn>;
const mockGetPr = getPr as ReturnType<typeof vi.fn>;
const mockCreatePr = createPr as ReturnType<typeof vi.fn>;
const mockUpdatePrBody = updatePrBody as ReturnType<typeof vi.fn>;
const mockReadState = readState as ReturnType<typeof vi.fn>;
const mockWriteState = writeState as ReturnType<typeof vi.fn>;

function makeState(
	branches: { name: string; parent: string | null; type?: "root" }[],
): DubState {
	return {
		stacks: [
			{
				id: "stack-uuid",
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
	mockEnsureGhInstalled.mockResolvedValue(undefined);
	mockCheckGhAuth.mockResolvedValue(undefined);
	mockWriteState.mockResolvedValue(undefined);
	mockPushBranch.mockResolvedValue(undefined);
	mockGetBranchTip.mockImplementation(
		async (branch: string) => `${branch}-sha`,
	);
	mockUpdatePrBody.mockResolvedValue(undefined);
});

describe("submit", () => {
	it("throws when branch is not in any stack", async () => {
		mockGetCurrentBranch.mockResolvedValue("orphan");
		mockReadState.mockResolvedValue({ stacks: [] });

		await expect(submit("/repo", false)).rejects.toThrow(
			"not part of any stack",
		);
	});

	it("throws when on a root branch", async () => {
		mockGetCurrentBranch.mockResolvedValue("main");
		mockReadState.mockResolvedValue(
			makeState([
				{ name: "main", parent: null, type: "root" },
				{ name: "feat/a", parent: "main" },
			]),
		);

		await expect(submit("/repo", false)).rejects.toThrow(
			"Cannot submit from a root branch",
		);
		await expect(submit("/repo", false)).rejects.toThrow("dub up");
	});

	it("throws when stack has branching children", async () => {
		mockGetCurrentBranch.mockResolvedValue("feat/a");
		mockReadState.mockResolvedValue(
			makeState([
				{ name: "main", parent: null, type: "root" },
				{ name: "feat/a", parent: "main" },
				{ name: "feat/b", parent: "feat/a" },
				{ name: "feat/c", parent: "feat/a" },
			]),
		);

		await expect(submit("/repo", false)).rejects.toThrow("Branching stacks");
		await expect(submit("/repo", false)).rejects.toThrow("dub track");
	});

	it("dry-run does not call push or gh commands", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
		mockGetCurrentBranch.mockResolvedValue("feat/a");
		mockReadState.mockResolvedValue(
			makeState([
				{ name: "main", parent: null, type: "root" },
				{ name: "feat/a", parent: "main" },
			]),
		);

		const result = await submit("/repo", true);

		expect(result.pushed).toEqual(["feat/a"]);
		expect(mockPushBranch).not.toHaveBeenCalled();
		expect(mockCreatePr).not.toHaveBeenCalled();
		expect(mockUpdatePrBody).not.toHaveBeenCalled();
		expect(mockWriteState).not.toHaveBeenCalled();
		expect(logSpy).toHaveBeenCalledWith(
			expect.stringContaining("Submitting 1 branch"),
		);
		logSpy.mockRestore();
	});

	it("creates new PRs for branches without existing PRs", async () => {
		mockGetCurrentBranch.mockResolvedValue("feat/a");
		mockReadState.mockResolvedValue(
			makeState([
				{ name: "main", parent: null, type: "root" },
				{ name: "feat/a", parent: "main" },
			]),
		);
		mockGetPr.mockResolvedValue(null);
		mockGetLastCommitMessage.mockResolvedValue("feat: new feature");
		mockCreatePr.mockResolvedValue({
			number: 42,
			url: "https://github.com/o/r/pull/42",
			title: "feat: new feature",
			body: "",
		});

		const result = await submit("/repo", false);

		expect(result.created).toEqual(["feat/a"]);
		expect(mockPushBranch).toHaveBeenCalledWith("feat/a", "/repo");
		expect(mockWriteState).toHaveBeenCalled();
	});

	it("updates existing PRs instead of creating", async () => {
		mockGetCurrentBranch.mockResolvedValue("feat/a");
		mockReadState.mockResolvedValue(
			makeState([
				{ name: "main", parent: null, type: "root" },
				{ name: "feat/a", parent: "main" },
			]),
		);
		mockGetPr.mockResolvedValue({
			number: 42,
			url: "https://github.com/o/r/pull/42",
			title: "feat: existing",
			body: "old body",
		});

		const result = await submit("/repo", false);

		expect(result.updated).toEqual(["feat/a"]);
		expect(result.created).toEqual([]);
		expect(mockCreatePr).not.toHaveBeenCalled();
		expect(mockUpdatePrBody).toHaveBeenCalled();
	});

	it("saves pr_number and pr_link to state", async () => {
		const state = makeState([
			{ name: "main", parent: null, type: "root" },
			{ name: "feat/a", parent: "main" },
		]);
		mockGetCurrentBranch.mockResolvedValue("feat/a");
		mockReadState.mockResolvedValue(state);
		mockGetPr.mockResolvedValue(null);
		mockGetLastCommitMessage.mockResolvedValue("feat: thing");
		mockCreatePr.mockResolvedValue({
			number: 99,
			url: "https://github.com/o/r/pull/99",
			title: "feat: thing",
			body: "",
		});

		await submit("/repo", false);

		const savedState = mockWriteState.mock.calls[0][0] as DubState;
		const featBranch = savedState.stacks[0].branches.find(
			(b) => b.name === "feat/a",
		);
		expect(featBranch?.pr_number).toBe(99);
		expect(featBranch?.pr_link).toBe("https://github.com/o/r/pull/99");
		expect(featBranch?.last_submitted_version).toMatchObject({
			head_sha: "feat/a-sha",
			base_sha: "main-sha",
			base_branch: "main",
			source: "submit",
		});
		expect(featBranch?.sync_source).toBe("submit");
		expect(featBranch?.last_synced_at).toBeTruthy();
	});
});
