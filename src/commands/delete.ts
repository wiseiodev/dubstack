import { stdin as input, stdout as output } from "node:process";
import * as readline from "node:readline/promises";
import { deleteTrackedBranch, getDeletePreview } from "../lib/delete";
import { DubError } from "../lib/errors";
import { getCurrentBranch } from "../lib/git";

interface DeleteCommandOptions {
	upstack?: boolean;
	downstack?: boolean;
	force?: boolean;
	quiet?: boolean;
	interactive?: boolean;
}

interface DeleteCommandResult {
	deleted: string[];
	reparented: Array<{ branch: string; parent: string | null }>;
	cancelled?: boolean;
}

function isInteractiveShell(): boolean {
	return Boolean(process.stdout.isTTY && process.stdin.isTTY);
}

async function confirmDelete(targets: string[]): Promise<boolean> {
	const rl = readline.createInterface({ input, output });
	try {
		const answer = await rl.question(
			`Delete ${targets.length} branch(es): ${targets.join(", ")}? [y/N] `,
		);
		const normalized = answer.trim().toLowerCase();
		return normalized === "y" || normalized === "yes";
	} finally {
		rl.close();
	}
}

export async function deleteCommand(
	cwd: string,
	branchArg?: string,
	options: DeleteCommandOptions = {},
): Promise<DeleteCommandResult> {
	const branch = branchArg ?? (await getCurrentBranch(cwd));
	const interactive = options.interactive ?? isInteractiveShell();
	const preview = await getDeletePreview(cwd, {
		branch,
		upstack: options.upstack,
		downstack: options.downstack,
	});

	if (!options.force && !options.quiet) {
		if (!interactive) {
			throw new DubError(
				"Delete requires confirmation. Re-run with --force or interactively.",
			);
		}
		const confirmed = await confirmDelete(preview.targets);
		if (!confirmed) {
			return { deleted: [], reparented: [], cancelled: true };
		}
	}

	const result = await deleteTrackedBranch(cwd, {
		branch,
		upstack: options.upstack ?? false,
		downstack: options.downstack ?? false,
		force: options.force ?? false,
	});
	return { ...result, cancelled: false };
}
