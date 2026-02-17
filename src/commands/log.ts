import { branchExists, getCurrentBranch } from "../lib/git.js";
import type { Branch, Stack } from "../lib/state.js";
import { readState } from "../lib/state.js";

/**
 * Renders an ASCII tree view of all tracked stacks.
 *
 * Highlights the current branch, marks branches missing from git,
 * and handles multiple stacks separated by blank lines.
 *
 * @param cwd - Working directory (must be inside an initialized dubstack repo)
 * @returns Formatted ASCII tree string (no ANSI colors — caller adds chalk)
 * @throws {DubError} If not initialized
 */
export async function log(cwd: string): Promise<string> {
	const state = await readState(cwd);

	if (state.stacks.length === 0) {
		return "No stacks. Run 'dub create' to start.";
	}

	let currentBranch: string | null = null;
	try {
		currentBranch = await getCurrentBranch(cwd);
	} catch {
		// Detached HEAD or empty repo — no branch highlighted
	}

	const sections: string[] = [];

	for (const stack of state.stacks) {
		const tree = await renderStack(stack, currentBranch, cwd);
		sections.push(tree);
	}

	return sections.join("\n\n");
}

async function renderStack(
	stack: Stack,
	currentBranch: string | null,
	cwd: string,
): Promise<string> {
	const root = stack.branches.find((b) => b.type === "root");
	if (!root) return "";

	const childMap = new Map<string, Branch[]>();
	for (const branch of stack.branches) {
		if (branch.parent) {
			const children = childMap.get(branch.parent) ?? [];
			children.push(branch);
			childMap.set(branch.parent, children);
		}
	}

	const lines: string[] = [];
	await renderNode(root, currentBranch, childMap, "", true, true, lines, cwd);
	return lines.join("\n");
}

async function renderNode(
	branch: Branch,
	currentBranch: string | null,
	childMap: Map<string, Branch[]>,
	prefix: string,
	isRoot: boolean,
	isLast: boolean,
	lines: string[],
	cwd: string,
): Promise<void> {
	let label: string;
	const exists = await branchExists(branch.name, cwd);

	if (isRoot) {
		label = `(${branch.name})`;
	} else if (branch.name === currentBranch) {
		label = `*${branch.name} (Current)*`;
	} else if (!exists) {
		label = `${branch.name} ⚠ (missing)`;
	} else {
		label = branch.name;
	}

	if (isRoot) {
		lines.push(label);
	} else {
		const connector = isLast ? "└─ " : "├─ ";
		lines.push(`${prefix}${connector}${label}`);
	}

	const children = childMap.get(branch.name) ?? [];
	const childPrefix = isRoot ? "  " : `${prefix}${isLast ? "     " : "│    "}`;

	for (let i = 0; i < children.length; i++) {
		const isChildLast = i === children.length - 1;
		await renderNode(
			children[i],
			currentBranch,
			childMap,
			childPrefix,
			false,
			isChildLast,
			lines,
			cwd,
		);
	}
}
