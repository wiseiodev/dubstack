import search from "@inquirer/search";
import { DubError } from "../lib/errors";
import { checkoutBranch, getCurrentBranch, listBranches } from "../lib/git";
import { type DubState, readState } from "../lib/state";

/**
 * Returns a sorted, deduplicated list of branch names tracked by DubStack.
 * Root branches that appear in multiple stacks are included only once.
 */
export function getTrackedBranches(state: DubState): string[] {
	const names = new Set<string>();
	for (const stack of state.stacks) {
		for (const branch of stack.branches) {
			names.add(branch.name);
		}
	}
	return [...names].sort();
}

/**
 * Filters tracked branches against the list of actual local git branches.
 * Removes any branches that are tracked in state but have been deleted locally.
 */
export function getValidBranches(tracked: string[], local: string[]): string[] {
	const localSet = new Set(local);
	return tracked.filter((b) => localSet.has(b));
}

/**
 * Checks out the named branch.
 *
 * @param name - Branch to switch to
 * @param cwd - Working directory
 * @returns The checked-out branch name
 * @throws {DubError} If the branch does not exist
 */
export async function checkout(
	name: string,
	cwd: string,
): Promise<{ branch: string }> {
	await checkoutBranch(name, cwd);
	return { branch: name };
}

/**
 * Launches an interactive search prompt listing DubStack-tracked branches.
 *
 * The current branch is shown but disabled. The user can type to filter,
 * use arrow keys to navigate, and press Enter to checkout.
 *
 * @param cwd - Working directory
 * @returns The checked-out branch, or `null` if the user cancelled (Ctrl+C)
 * @throws {DubError} If not initialized or no tracked branches exist
 */
export async function interactiveCheckout(
	cwd: string,
): Promise<{ branch: string } | null> {
	const state = await readState(cwd);
	const trackedBranches = getTrackedBranches(state);
	const localBranches = await listBranches(cwd);

	const validBranches = getValidBranches(trackedBranches, localBranches);

	if (validBranches.length === 0) {
		throw new DubError(
			"No valid tracked branches found. Run 'dub create' first.",
		);
	}

	let currentBranch: string | null = null;
	try {
		currentBranch = await getCurrentBranch(cwd);
	} catch {
		// Detached HEAD — no branch marked as current
	}

	// Setup AbortController for Esc key support
	const controller = new AbortController();

	// Listen for keypress events to handle Esc
	const onKeypress = (_str: string, key: { name: string; ctrl: boolean }) => {
		if (key && key.name === "escape") {
			controller.abort();
		}
	};
	process.stdin.on("keypress", onKeypress);

	try {
		const selected = await search(
			{
				message: "Checkout a branch (autocomplete or arrow keys)",
				source(term: string | undefined) {
					const filtered = term
						? validBranches.filter((b) =>
								b.toLowerCase().includes(term.toLowerCase()),
							)
						: validBranches;

					return filtered.map((name) => ({
						name,
						value: name,
						disabled: name === currentBranch ? "(current)" : false,
					}));
				},
			},
			{ signal: controller.signal },
		);

		return checkout(selected, cwd);
	} catch (error: unknown) {
		if (error instanceof Error) {
			if (
				error.name === "ExitPromptError" ||
				error.name === "AbortError" ||
				error.name === "AbortPromptError"
			) {
				return null;
			}
		}
		throw error;
	} finally {
		process.stdin.off("keypress", onKeypress);
	}
}
