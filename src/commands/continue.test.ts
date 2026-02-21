import { beforeEach, describe, expect, it, vi } from "vitest";
import { DubError } from "../lib/errors";
import { rebaseContinue } from "../lib/git";
import { detectActiveOperation } from "../lib/operation-state";
import { continueCommand } from "./continue";
import { restackContinue } from "./restack";

vi.mock("../lib/operation-state");
vi.mock("../lib/git");
vi.mock("./restack");

describe("continue command", () => {
	const cwd = "/tmp/repo";

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(restackContinue).mockResolvedValue({
			status: "success",
			rebased: ["feat/a"],
		});
		vi.mocked(rebaseContinue).mockResolvedValue(undefined);
	});

	it("throws when no operation is active", async () => {
		vi.mocked(detectActiveOperation).mockResolvedValue("none");

		await expect(continueCommand(cwd)).rejects.toThrow(DubError);
		await expect(continueCommand(cwd)).rejects.toThrow("No operation");
	});

	it("continues an active rebase", async () => {
		vi.mocked(detectActiveOperation).mockResolvedValue("rebase");

		const result = await continueCommand(cwd);

		expect(rebaseContinue).toHaveBeenCalledWith(cwd);
		expect(result.continued).toBe("rebase");
	});

	it("continues a restack operation", async () => {
		vi.mocked(detectActiveOperation).mockResolvedValue("restack");

		const result = await continueCommand(cwd);

		expect(restackContinue).toHaveBeenCalledWith(cwd);
		expect(result.continued).toBe("restack");
	});
});
