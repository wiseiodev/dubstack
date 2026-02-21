import { DubError } from "../lib/errors";
import { rebaseContinue } from "../lib/git";
import { detectActiveOperation } from "../lib/operation-state";
import { restackContinue } from "./restack";

interface ContinueCommandResult {
	continued: "rebase" | "restack";
	restackResult?: Awaited<ReturnType<typeof restackContinue>>;
}

export async function continueCommand(
	cwd: string,
): Promise<ContinueCommandResult> {
	const active = await detectActiveOperation(cwd);
	if (active === "none") {
		throw new DubError(
			"No operation in progress. Start a restack or resolve a rebase first.",
		);
	}

	if (active === "restack") {
		const restackResult = await restackContinue(cwd);
		return { continued: "restack", restackResult };
	}

	await rebaseContinue(cwd);
	return { continued: "rebase" };
}
