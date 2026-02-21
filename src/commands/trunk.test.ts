import { beforeEach, describe, expect, it, vi } from "vitest";
import { getCurrentBranch } from "../lib/git";
import { readState } from "../lib/state";
import { trunk } from "./trunk";

vi.mock("../lib/git");
vi.mock("../lib/state", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/state")>();
	return {
		...actual,
		readState: vi.fn(),
	};
});

describe("trunk command", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns trunk for tracked branch", async () => {
		vi.mocked(getCurrentBranch).mockResolvedValue("feat/a");
		vi.mocked(readState).mockResolvedValue({
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
					],
				},
			],
		});

		const result = await trunk("/tmp/repo");
		expect(result.trunk).toBe("main");
	});

	it("throws with remediation for untracked branch", async () => {
		vi.mocked(getCurrentBranch).mockResolvedValue("feat/a");
		vi.mocked(readState).mockResolvedValue({ stacks: [] });

		await expect(trunk("/tmp/repo")).rejects.toThrow("dub track");
	});
});
