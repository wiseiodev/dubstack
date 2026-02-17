import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { DubError } from "./errors.js";
import { getRepoRoot } from "./git.js";

/** A branch within a stack. */
export interface Branch {
	/** Branch name, e.g. "feat/api-endpoint" */
	name: string;
	/** Set to "root" for the base branch (e.g. main). Omitted for children. */
	type?: "root";
	/** Name of the parent branch. `null` only for root branches. */
	parent: string | null;
	/** GitHub PR URL. Populated in Phase 2. */
	pr_link: string | null;
}

/** A stack of dependent branches. */
export interface Stack {
	/** Unique identifier for this stack. */
	id: string;
	/** Ordered list of branches in the stack. */
	branches: Branch[];
}

/** Root state persisted to `.git/dubstack/state.json`. */
export interface DubState {
	/** All tracked stacks in this repository. */
	stacks: Stack[];
}

/**
 * Returns the absolute path to the dubstack state file.
 * @throws {DubError} If not inside a git repository.
 */
export async function getStatePath(cwd: string): Promise<string> {
	const root = await getRepoRoot(cwd);
	return path.join(root, ".git", "dubstack", "state.json");
}

/**
 * Returns the absolute path to the dubstack directory inside `.git`.
 * @throws {DubError} If not inside a git repository.
 */
export async function getDubDir(cwd: string): Promise<string> {
	const root = await getRepoRoot(cwd);
	return path.join(root, ".git", "dubstack");
}

/**
 * Reads and parses the dubstack state file.
 * @throws {DubError} If the state file is missing or contains invalid JSON.
 */
export async function readState(cwd: string): Promise<DubState> {
	const statePath = await getStatePath(cwd);
	if (!fs.existsSync(statePath)) {
		throw new DubError("DubStack is not initialized. Run 'dub init' first.");
	}
	try {
		const raw = fs.readFileSync(statePath, "utf-8");
		return JSON.parse(raw) as DubState;
	} catch {
		throw new DubError(
			"State file is corrupted. Delete .git/dubstack and run 'dub init' to re-initialize.",
		);
	}
}

/**
 * Writes the dubstack state to disk.
 * Creates the parent directory if it doesn't exist.
 */
export async function writeState(state: DubState, cwd: string): Promise<void> {
	const statePath = await getStatePath(cwd);
	const dir = path.dirname(statePath);
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
	fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

/**
 * Initializes the dubstack state directory and file.
 * Idempotent — returns `"already_exists"` if already initialized.
 *
 * @returns `"created"` if freshly initialized, `"already_exists"` if state file already present.
 */
export async function initState(
	cwd: string,
): Promise<"created" | "already_exists"> {
	const statePath = await getStatePath(cwd);
	const dir = path.dirname(statePath);

	if (fs.existsSync(statePath)) {
		return "already_exists";
	}

	fs.mkdirSync(dir, { recursive: true });
	const emptyState: DubState = { stacks: [] };
	fs.writeFileSync(statePath, `${JSON.stringify(emptyState, null, 2)}\n`);
	return "created";
}

/**
 * Finds the stack containing a given branch.
 * @returns The matching stack, or `undefined` if the branch isn't tracked.
 */
export function findStackForBranch(
	state: DubState,
	name: string,
): Stack | undefined {
	return state.stacks.find((stack) =>
		stack.branches.some((b) => b.name === name),
	);
}

/**
 * Adds a child branch to the state, linking it to its parent.
 *
 * Decision tree:
 * 1. If `child` already exists in any stack → throws `DubError` (no duplicates)
 * 2. If `parent` is found in an existing stack → appends child to that stack
 * 3. If `parent` is not in any stack → creates a new stack with parent as root
 *
 * @param state - The state to mutate (modified in place)
 * @param child - Name of the new branch
 * @param parent - Name of the parent branch
 * @throws {DubError} If child branch already exists in state
 */
export function addBranchToStack(
	state: DubState,
	child: string,
	parent: string,
): void {
	if (findStackForBranch(state, child)) {
		throw new DubError(`Branch '${child}' is already tracked in a stack.`);
	}

	const childBranch: Branch = { name: child, parent, pr_link: null };
	const existingStack = findStackForBranch(state, parent);

	if (existingStack) {
		existingStack.branches.push(childBranch);
	} else {
		const rootBranch: Branch = {
			name: parent,
			type: "root",
			parent: null,
			pr_link: null,
		};
		state.stacks.push({
			id: crypto.randomUUID(),
			branches: [rootBranch, childBranch],
		});
	}
}
