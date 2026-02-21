import { beforeEach, describe, expect, it, vi } from "vitest";
import * as git from "../lib/git";
import * as state from "../lib/state";
import { modify } from "./modify";
import * as restackModule from "./restack";

vi.mock("../lib/git");
vi.mock("../lib/state");
vi.mock("./restack");

describe("modify", () => {
	const cwd = "/tmp/test";

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("should amend commit by default", async () => {
		vi.mocked(git.getCurrentBranch).mockResolvedValue("feature-branch");
		vi.mocked(state.readState).mockResolvedValue({ stacks: [] });
		vi.mocked(git.hasStagedChanges).mockResolvedValue(true);
		vi.mocked(git.isWorkingTreeClean).mockResolvedValue(true);

		await modify(cwd, {});

		expect(git.amendCommit).toHaveBeenCalledWith(cwd, {
			message: undefined,
			noEdit: false,
		});
		expect(restackModule.restack).toHaveBeenCalled();
	});

	it("should create new commit with -c flag", async () => {
		vi.mocked(git.getCurrentBranch).mockResolvedValue("feature-branch");
		vi.mocked(state.readState).mockResolvedValue({ stacks: [] });
		vi.mocked(git.hasStagedChanges).mockResolvedValue(true);

		await modify(cwd, { commit: true, message: "new commit" });

		expect(git.commit).toHaveBeenCalledWith(cwd, {
			message: "new commit",
			noEdit: true,
		});
		expect(restackModule.restack).toHaveBeenCalled();
	});

	it("should stage all changes with -a flag", async () => {
		vi.mocked(git.getCurrentBranch).mockResolvedValue("feature-branch");
		vi.mocked(state.readState).mockResolvedValue({ stacks: [] });
		vi.mocked(git.hasStagedChanges).mockResolvedValue(true);

		await modify(cwd, { all: true });

		expect(git.stageAll).toHaveBeenCalledWith(cwd);
		expect(git.amendCommit).toHaveBeenCalled();
	});

	it("should run interactive rebase when requested", async () => {
		vi.mocked(git.getCurrentBranch).mockResolvedValue("feature-branch");
		vi.mocked(state.getParent).mockReturnValue("main");

		vi.mocked(state.readState).mockResolvedValue({
			stacks: [
				{
					id: "1",
					branches: [
						{
							name: "main",
							type: "root",
							parent: null,
							pr_number: null,
							pr_link: null,
						},
						{
							name: "feature-branch",
							parent: "main",
							pr_number: null,
							pr_link: null,
						},
					],
				},
			],
		});
		vi.mocked(git.getBranchTip).mockResolvedValue("sha-main");

		await modify(cwd, { interactiveRebase: true });

		expect(git.interactiveRebase).toHaveBeenCalledWith("sha-main", cwd);
		expect(restackModule.restack).toHaveBeenCalled();
	});

	it("prints staged diff with --verbose", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
		vi.mocked(git.getCurrentBranch).mockResolvedValue("feature-branch");
		vi.mocked(state.readState).mockResolvedValue({ stacks: [] });
		vi.mocked(git.hasStagedChanges).mockResolvedValue(true);
		vi.mocked(git.getDiff).mockResolvedValue("staged diff");

		await modify(cwd, { verbose: 1 });

		expect(git.getDiff).toHaveBeenCalledWith(cwd, true);
		expect(logSpy).toHaveBeenCalledWith("staged diff");
		logSpy.mockRestore();
	});

	it("prints unstaged diff too with --verbose --verbose", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
		vi.mocked(git.getCurrentBranch).mockResolvedValue("feature-branch");
		vi.mocked(state.readState).mockResolvedValue({ stacks: [] });
		vi.mocked(git.hasStagedChanges).mockResolvedValue(true);
		vi.mocked(git.getDiff)
			.mockResolvedValueOnce("staged diff")
			.mockResolvedValueOnce("unstaged diff");

		await modify(cwd, { verbose: 2 });

		expect(git.getDiff).toHaveBeenNthCalledWith(1, cwd, true);
		expect(git.getDiff).toHaveBeenNthCalledWith(2, cwd, false);
		expect(logSpy).toHaveBeenCalledWith("staged diff");
		expect(logSpy).toHaveBeenCalledWith("unstaged diff");
		logSpy.mockRestore();
	});

	it("joins multiple -m values into one commit message", async () => {
		vi.mocked(git.getCurrentBranch).mockResolvedValue("feature-branch");
		vi.mocked(state.readState).mockResolvedValue({ stacks: [] });
		vi.mocked(git.hasStagedChanges).mockResolvedValue(true);

		await modify(cwd, {
			commit: true,
			message: ["line one", "line two"],
		});

		expect(git.commit).toHaveBeenCalledWith(cwd, {
			message: "line one\n\nline two",
			noEdit: true,
		});
	});
});
