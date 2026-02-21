import { DubError } from "../lib/errors";
import { rebaseAbort } from "../lib/git";
import {
	clearRestackProgress,
	detectActiveOperation,
	hasGitRebaseInProgress,
} from "../lib/operation-state";

interface AbortCommandResult {
	aborted: "rebase" | "restack";
}

export async function abortCommand(cwd: string): Promise<AbortCommandResult> {
	const active = await detectActiveOperation(cwd);
	if (active === "none") {
		throw new DubError("No operation in progress. Nothing to abort.");
	}

	if (await hasGitRebaseInProgress(cwd)) {
		await rebaseAbort(cwd);
	}
	if (active === "restack") {
		await clearRestackProgress(cwd);
	}

	return { aborted: active };
}
