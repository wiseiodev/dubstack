#!/usr/bin/env node

/**
 * DubStack CLI — manage stacked diffs with ease.
 *
 * A local-first tool for managing chains of dependent git branches
 * (stacked diffs) without manually dealing with complex rebase chains.
 *
 * @example
 * ```bash
 * dub init                    # Initialize in current repo
 * dub create feat/my-branch   # Create stacked branch
 * dub log                     # View stack tree
 * dub restack                 # Rebase stack onto updated parent
 * dub undo                    # Undo last dub operation
 * ```
 *
 * @packageDocumentation
 */

import { createRequire } from "node:module";
import chalk from "chalk";
import { Command } from "commander";
import { create } from "./commands/create.js";
import { init } from "./commands/init.js";
import { log } from "./commands/log.js";
import { restack, restackContinue } from "./commands/restack.js";
import { undo } from "./commands/undo.js";
import { DubError } from "./lib/errors.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

const program = new Command();

program
	.name("dub")
	.description("Manage stacked diffs (dependent git branches) with ease")
	.version(version);

program
	.command("init")
	.description("Initialize DubStack in the current git repository")
	.addHelpText(
		"after",
		`
Examples:
  $ dub init    Initialize DubStack, creating .git/dubstack/ and updating .gitignore`,
	)
	.action(async () => {
		const result = await init(process.cwd());
		if (result.status === "created") {
			console.log(chalk.green("✔ DubStack initialized"));
		} else {
			console.log(chalk.yellow("⚠ DubStack already initialized"));
		}
	});

program
	.command("create")
	.argument("<branch-name>", "Name of the new branch to create")
	.description("Create a new branch stacked on top of the current branch")
	.addHelpText(
		"after",
		`
Examples:
  $ dub create feat/api-endpoint      Create a branch on top of current branch
  $ dub create feat/ui-component      Stack another branch on top`,
	)
	.action(async (branchName: string) => {
		const result = await create(branchName, process.cwd());
		console.log(
			chalk.green(
				`✔ Created branch '${result.branch}' on top of '${result.parent}'`,
			),
		);
	});

program
	.command("log")
	.description("Display an ASCII tree of the current stack")
	.addHelpText(
		"after",
		`
Examples:
  $ dub log    Show the branch tree with current branch highlighted`,
	)
	.action(async () => {
		const output = await log(process.cwd());
		// Apply chalk styling to the output
		const styled = output
			.replace(/\*(.+?) \(Current\)\*/g, chalk.bold.cyan("$1 (Current)"))
			.replace(/⚠ \(missing\)/g, chalk.yellow("⚠ (missing)"));
		console.log(styled);
	});

program
	.command("restack")
	.description("Rebase all branches in the stack onto their updated parents")
	.option("--continue", "Continue restacking after resolving conflicts")
	.addHelpText(
		"after",
		`
Examples:
  $ dub restack              Rebase the current stack
  $ dub restack --continue   Continue after resolving conflicts`,
	)
	.action(async (options: { continue?: boolean }) => {
		const result = options.continue
			? await restackContinue(process.cwd())
			: await restack(process.cwd());

		if (result.status === "up-to-date") {
			console.log(chalk.green("✔ Stack is already up to date"));
		} else if (result.status === "conflict") {
			console.log(
				chalk.yellow(`⚠ Conflict while restacking '${result.conflictBranch}'`),
			);
			console.log(
				chalk.dim(
					"  Resolve conflicts, stage changes, then run: dub restack --continue",
				),
			);
		} else {
			console.log(
				chalk.green(`✔ Restacked ${result.rebased.length} branch(es)`),
			);
			for (const branch of result.rebased) {
				console.log(chalk.dim(`  ↳ ${branch}`));
			}
		}
	});

program
	.command("undo")
	.description("Undo the last dub create or dub restack operation")
	.addHelpText(
		"after",
		`
Examples:
  $ dub undo    Roll back the last dub operation`,
	)
	.action(async () => {
		const result = await undo(process.cwd());
		console.log(chalk.green(`✔ Undid '${result.undone}': ${result.details}`));
	});

async function main() {
	try {
		await program.parseAsync(process.argv);
	} catch (error) {
		if (error instanceof DubError) {
			console.error(chalk.red(`✖ ${error.message}`));
			process.exit(1);
		}
		throw error;
	}
}

main();
