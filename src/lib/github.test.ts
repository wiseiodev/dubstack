import {
	beforeEach,
	describe,
	expect,
	it,
	type MockInstance,
	vi,
} from "vitest";

vi.mock("execa", () => ({
	execa: vi.fn(),
}));

import { execa } from "execa";
import {
	checkGhAuth,
	createPr,
	ensureGhInstalled,
	getBranchPrLifecycleState,
	getPr,
	updatePrBody,
} from "./github";

const mockExeca = execa as unknown as MockInstance;

beforeEach(() => {
	vi.clearAllMocks();
});

describe("ensureGhInstalled", () => {
	it("resolves when gh is found", async () => {
		mockExeca.mockResolvedValueOnce({ stdout: "gh version 2.0.0" });
		await expect(ensureGhInstalled()).resolves.toBeUndefined();
	});

	it("throws DubError when gh is not found", async () => {
		mockExeca.mockRejectedValue(new Error("not found"));
		await expect(ensureGhInstalled()).rejects.toThrow("gh CLI not found");
	});
});

describe("checkGhAuth", () => {
	it("resolves when authenticated", async () => {
		mockExeca.mockResolvedValueOnce({ stdout: "" });
		await expect(checkGhAuth()).resolves.toBeUndefined();
	});

	it("throws DubError when not authenticated", async () => {
		mockExeca.mockRejectedValue(new Error("not logged in"));
		await expect(checkGhAuth()).rejects.toThrow("Not authenticated");
	});
});

describe("getPr", () => {
	it("returns PrInfo when PR exists", async () => {
		const prJson = JSON.stringify({
			number: 42,
			url: "https://github.com/o/r/pull/42",
			title: "feat: thing",
			body: "description",
		});
		mockExeca.mockResolvedValueOnce({ stdout: prJson });

		const result = await getPr("feat/thing", "/repo");

		expect(result).toEqual({
			number: 42,
			url: "https://github.com/o/r/pull/42",
			title: "feat: thing",
			body: "description",
		});
	});

	it("returns null when no PR exists", async () => {
		mockExeca.mockResolvedValueOnce({ stdout: "" });
		expect(await getPr("no-pr", "/repo")).toBeNull();
	});

	it("returns null when jq returns null", async () => {
		mockExeca.mockResolvedValueOnce({ stdout: "null" });
		expect(await getPr("no-pr", "/repo")).toBeNull();
	});
});

describe("getBranchPrLifecycleState", () => {
	it("returns NONE when no PR exists", async () => {
		mockExeca.mockResolvedValueOnce({ stdout: "null" });
		await expect(getBranchPrLifecycleState("feat/a", "/repo")).resolves.toBe(
			"NONE",
		);
	});

	it("returns MERGED when mergedAt is present", async () => {
		mockExeca.mockResolvedValueOnce({
			stdout: JSON.stringify({
				state: "CLOSED",
				mergedAt: "2026-01-01T00:00:00Z",
			}),
		});
		await expect(getBranchPrLifecycleState("feat/a", "/repo")).resolves.toBe(
			"MERGED",
		);
	});

	it("returns CLOSED/OPEN from state", async () => {
		mockExeca.mockResolvedValueOnce({
			stdout: JSON.stringify({ state: "CLOSED", mergedAt: null }),
		});
		await expect(getBranchPrLifecycleState("feat/a", "/repo")).resolves.toBe(
			"CLOSED",
		);

		mockExeca.mockResolvedValueOnce({
			stdout: JSON.stringify({ state: "OPEN", mergedAt: null }),
		});
		await expect(getBranchPrLifecycleState("feat/a", "/repo")).resolves.toBe(
			"OPEN",
		);
	});
});

describe("createPr", () => {
	it("parses PR number from stdout URL", async () => {
		mockExeca.mockResolvedValueOnce({
			stdout: "https://github.com/o/r/pull/99\n",
		});

		const result = await createPr(
			"feat/x",
			"main",
			"title",
			"/tmp/body.md",
			"/repo",
		);

		expect(result.number).toBe(99);
		expect(result.url).toBe("https://github.com/o/r/pull/99");
	});

	it("throws descriptive error on 403", async () => {
		mockExeca.mockRejectedValueOnce(new Error("403 Forbidden"));

		await expect(
			createPr("feat/x", "main", "title", "/tmp/body.md", "/repo"),
		).rejects.toThrow("permissions");
	});

	it("throws on unexpected output", async () => {
		mockExeca.mockResolvedValueOnce({ stdout: "something unexpected" });

		await expect(
			createPr("feat/x", "main", "title", "/tmp/body.md", "/repo"),
		).rejects.toThrow("Unexpected output");
	});
});

describe("updatePrBody", () => {
	it("calls gh pr edit with correct args", async () => {
		mockExeca.mockResolvedValueOnce({ stdout: "" });

		await updatePrBody(42, "/tmp/body.md", "/repo");

		expect(mockExeca).toHaveBeenCalledWith(
			"gh",
			["pr", "edit", "42", "--body-file", "/tmp/body.md"],
			{ cwd: "/repo" },
		);
	});

	it("throws descriptive error on 403", async () => {
		mockExeca.mockRejectedValueOnce(new Error("403 insufficient scope"));

		await expect(updatePrBody(42, "/tmp/body.md", "/repo")).rejects.toThrow(
			"permissions",
		);
	});
});
