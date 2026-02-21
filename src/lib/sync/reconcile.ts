export type ReconcileDecision =
	| "take-remote"
	| "keep-local"
	| "reconcile"
	| "skip";

export async function resolveReconcileDecision(input: {
	branch: string;
	force: boolean;
	interactive: boolean;
	promptChoice: () => Promise<string>;
}): Promise<ReconcileDecision> {
	if (input.force) return "take-remote";
	if (!input.interactive) return "skip";

	const raw = await input.promptChoice();
	if (
		raw === "take-remote" ||
		raw === "keep-local" ||
		raw === "reconcile" ||
		raw === "skip"
	) {
		return raw;
	}
	return "skip";
}
