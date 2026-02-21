import { describe, expect, it } from "vitest";
import { assertAcyclic, getAncestors, getDescendants } from "./graph";
import type { Stack } from "./state";

function makeStack(): Stack {
	return {
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
			{
				name: "feat/b",
				parent: "feat/a",
				pr_number: null,
				pr_link: null,
			},
			{
				name: "feat/c",
				parent: "feat/a",
				pr_number: null,
				pr_link: null,
			},
			{
				name: "feat/d",
				parent: "feat/b",
				pr_number: null,
				pr_link: null,
			},
		],
	};
}

describe("getDescendants", () => {
	it("returns all descendants for a branch", () => {
		const descendants = getDescendants(makeStack(), "feat/a");
		expect(descendants).toEqual(["feat/b", "feat/c", "feat/d"]);
	});

	it("returns empty array for branch with no children", () => {
		const descendants = getDescendants(makeStack(), "feat/d");
		expect(descendants).toEqual([]);
	});
});

describe("getAncestors", () => {
	it("returns ancestors from parent toward root", () => {
		const ancestors = getAncestors(makeStack(), "feat/d");
		expect(ancestors).toEqual(["feat/b", "feat/a", "main"]);
	});

	it("returns empty array for root branch", () => {
		const ancestors = getAncestors(makeStack(), "main");
		expect(ancestors).toEqual([]);
	});
});

describe("assertAcyclic", () => {
	it("does not throw for an acyclic stack", () => {
		expect(() => assertAcyclic(makeStack())).not.toThrow();
	});

	it("throws when a cycle exists", () => {
		const stack = makeStack();
		const featA = stack.branches.find((branch) => branch.name === "feat/a");
		if (featA) {
			featA.parent = "feat/d";
		}

		expect(() => assertAcyclic(stack)).toThrow("cycle");
	});
});
