import { stdin as input, stdout as output } from "node:process";
import * as readline from "node:readline/promises";
import { DubError } from "../lib/errors";
import { getCurrentBranch } from "../lib/git";
import { getUntrackContext, type UntrackResult, untrackBranch } from "../lib/untrack";

interface UntrackCommandOptions {
	downstack?: boolean;
	interactive?: boolean;
}

function isInteractiveShell(): boolean {
	return Boolean(process.stdout.isTTY && process.stdin.isTTY);
}

async function confirmDownstack(branch: string, descendants: string[]) {
	const rl = readline.createInterface({ input, output });
	try {
		const answer = await rl.question(
			`Branch '${branch}' has descendants (${descendants.join(", ")}). Untrack them too? [y/N] `,
		);
		const normalized = answer.trim().toLowerCase();
		return normalized === "y" || normalized === "yes";
	} finally {
		rl.close();
	}
}

export async function untrack(
	cwd: string,
	branchArg?: string,
	options: UntrackCommandOptions = {},
): Promise<UntrackResult> {
	const branch = branchArg ?? (await getCurrentBranch(cwd));
	const interactive = options.interactive ?? isInteractiveShell();
	let downstack = options.downstack ?? false;

	const context = await getUntrackContext(cwd, branch);
	if (context.descendants.length > 0 && !downstack) {
		if (!interactive) {
			throw new DubError(
				`Branch '${branch}' has descendants (${context.descendants.join(", ")}). Re-run with --downstack or interactive mode.`,
			);
		}
		downstack = await confirmDownstack(branch, context.descendants);
	}

	return untrackBranch(cwd, { branch, downstack });
}
