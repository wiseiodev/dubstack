import { describe, expect, it } from "vitest";
import {
	buildMetadataBlock,
	buildStackTable,
	composePrBody,
	stripDubstackSections,
} from "./pr-body";
import type { Branch } from "./state";

function branch(name: string, parent: string): Branch {
	return { name, parent, pr_number: null, pr_link: null };
}

describe("buildStackTable", () => {
	it("builds a table for a multi-branch stack", () => {
		const branches = [
			branch("feat/api", "main"),
			branch("feat/ui", "feat/api"),
		];
		const prMap = new Map([
			["feat/api", { number: 101, title: "feat: api" }],
			["feat/ui", { number: 102, title: "feat: ui" }],
		]);

		const result = buildStackTable(branches, prMap, "feat/ui");

		expect(result).toContain("### 🥞 DubStack");
		expect(result).toContain("- #101 feat: api");
		expect(result).toContain("- #102 feat: ui 👈");
		expect(result).toContain("<!-- dubstack:start -->");
		expect(result).toContain("<!-- dubstack:end -->");
	});

	it("marks the correct branch with 👈", () => {
		const branches = [branch("a", "main"), branch("b", "a")];
		const prMap = new Map([
			["a", { number: 1, title: "A" }],
			["b", { number: 2, title: "B" }],
		]);

		const result = buildStackTable(branches, prMap, "a");

		expect(result).toContain("- #1 A 👈");
		expect(result).not.toContain("- #2 B 👈");
	});

	it("handles a single-branch stack", () => {
		const branches = [branch("feat/solo", "main")];
		const prMap = new Map([
			["feat/solo", { number: 42, title: "solo change" }],
		]);

		const result = buildStackTable(branches, prMap, "feat/solo");

		expect(result).toContain("- #42 solo change 👈");
	});
});

describe("buildMetadataBlock", () => {
	it("produces valid metadata comment", () => {
		const result = buildMetadataBlock("uuid-1", 102, 101, 103, "feat/ui");

		expect(result).toContain("<!-- dubstack-metadata");
		expect(result).toContain("-->");
		expect(result).toContain('"stack_id": "uuid-1"');
		expect(result).toContain('"pr_number": 102');
		expect(result).toContain('"prev_pr": 101');
		expect(result).toContain('"next_pr": 103');
	});

	it("handles null prev/next for single-branch stack", () => {
		const result = buildMetadataBlock("uuid-2", 42, null, null, "feat/solo");

		expect(result).toContain('"prev_pr": null');
		expect(result).toContain('"next_pr": null');
	});
});

describe("stripDubstackSections", () => {
	it("removes dubstack markers and content", () => {
		const body = [
			"User description here",
			"<!-- dubstack:start -->",
			"---",
			"### 🥞 DubStack",
			"- #101 feat: api",
			"<!-- dubstack:end -->",
			"<!-- dubstack-metadata",
			'{ "stack_id": "x" }',
			"-->",
		].join("\n");

		const result = stripDubstackSections(body);

		expect(result).toBe("User description here");
	});

	it("returns body unchanged if no markers exist", () => {
		const body = "Just a normal PR description";
		expect(stripDubstackSections(body)).toBe(body);
	});

	it("is idempotent — double-strip returns same result", () => {
		const body =
			"Description\n<!-- dubstack:start -->\nstuff\n<!-- dubstack:end -->";
		const first = stripDubstackSections(body);
		const second = stripDubstackSections(first);
		expect(second).toBe(first);
	});
});

describe("composePrBody", () => {
	it("combines user content with stack sections", () => {
		const result = composePrBody("My PR", "STACK_TABLE", "META_BLOCK");

		expect(result).toBe("My PR\n\nSTACK_TABLE\n\nMETA_BLOCK");
	});

	it("strips stale sections before composing", () => {
		const existingBody =
			"My PR\n\n<!-- dubstack:start -->\nold table\n<!-- dubstack:end -->\n\n<!-- dubstack-metadata\nold meta\n-->";

		const result = composePrBody(existingBody, "NEW_TABLE", "NEW_META");

		expect(result).toBe("My PR\n\nNEW_TABLE\n\nNEW_META");
	});

	it("handles empty existing body", () => {
		const result = composePrBody("", "TABLE", "META");

		expect(result).toBe("TABLE\n\nMETA");
	});
});
