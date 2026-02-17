import * as fs from "node:fs";
import * as path from "node:path";
import { DubError } from "./errors.js";
import type { DubState } from "./state.js";
import { getDubDir } from "./state.js";

/**
 * Snapshot of system state before a mutation, used by `dub undo`.
 * Only one undo level is supported — each new mutation overwrites the previous snapshot.
 */
export interface UndoEntry {
	/** Which command created this snapshot. */
	operation: "create" | "restack";
	/** ISO timestamp of when the snapshot was taken. */
	timestamp: string;
	/** The branch user was on before the operation. */
	previousBranch: string;
	/** Full copy of state.json before mutation. */
	previousState: DubState;
	/** Map of branch name → commit SHA before mutation. */
	branchTips: Record<string, string>;
	/** Branches created by this operation (to be deleted on undo). */
	createdBranches: string[];
}

async function getUndoPath(cwd: string): Promise<string> {
	const dubDir = await getDubDir(cwd);
	return path.join(dubDir, "undo.json");
}

/**
 * Saves an undo entry to disk. Overwrites any previous entry (1 level only).
 */
export async function saveUndoEntry(
	entry: UndoEntry,
	cwd: string,
): Promise<void> {
	const undoPath = await getUndoPath(cwd);
	fs.writeFileSync(undoPath, `${JSON.stringify(entry, null, 2)}\n`);
}

/**
 * Reads the most recent undo entry.
 * @throws {DubError} If no undo entry exists.
 */
export async function readUndoEntry(cwd: string): Promise<UndoEntry> {
	const undoPath = await getUndoPath(cwd);
	if (!fs.existsSync(undoPath)) {
		throw new DubError("Nothing to undo.");
	}
	const raw = fs.readFileSync(undoPath, "utf-8");
	return JSON.parse(raw) as UndoEntry;
}

/**
 * Deletes the undo entry file. Called after a successful undo.
 */
export async function clearUndoEntry(cwd: string): Promise<void> {
	const undoPath = await getUndoPath(cwd);
	if (fs.existsSync(undoPath)) {
		fs.unlinkSync(undoPath);
	}
}
