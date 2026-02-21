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
import { branchInfo, formatBranchInfo } from "./commands/branch";
import { checkout, interactiveCheckout } from "./commands/checkout";
import { create } from "./commands/create";
import { init } from "./commands/init";
import { log } from "./commands/log";
import { bottom, down, top, up } from "./commands/navigate";
import { restack, restackContinue } from "./commands/restack";
import { submit } from "./commands/submit";
import { sync } from "./commands/sync";
import { undo } from "./commands/undo";
import { DubError } from "./lib/errors";

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
	.option("-m, --message <message>", "Commit staged changes with this message")
	.option("-a, --all", "Stage all changes before committing (requires -m)")
	.addHelpText(
		"after",
		`
Examples:
  $ dub create feat/api                       Create branch only
  $ dub create feat/api -m "feat: add API"    Create branch + commit staged
  $ dub create feat/api -am "feat: add API"   Stage all + create + commit`,
	)
	.action(
		async (
			branchName: string,
			options: { message?: string; all?: boolean },
		) => {
			const result = await create(branchName, process.cwd(), {
				message: options.message,
				all: options.all,
			});
			if (result.committed) {
				console.log(
					chalk.green(
						`✔ Created '${result.branch}' on '${result.parent}' • ${result.committed}`,
					),
				);
			} else {
				console.log(
					chalk.green(
						`✔ Created branch '${result.branch}' on top of '${result.parent}'`,
					),
				);
			}
		},
	);

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
		await printLog(process.cwd());
	});

program
	.command("ls")
	.description("Display an ASCII tree of the current stack")
	.action(async () => {
		await printLog(process.cwd());
	});

program
	.command("up")
	.description("Checkout the child branch directly above the current branch")
	.action(async () => {
		const result = await up(process.cwd());
		if (result.changed) {
			console.log(chalk.green(`✔ Switched up to '${result.branch}'`));
		} else {
			console.log(chalk.yellow(`⚠ Already at top branch '${result.branch}'`));
		}
	});

program
	.command("down")
	.description("Checkout the parent branch directly below the current branch")
	.action(async () => {
		const result = await down(process.cwd());
		if (result.changed) {
			console.log(chalk.green(`✔ Switched down to '${result.branch}'`));
		} else {
			console.log(
				chalk.yellow(`⚠ Already at bottom branch '${result.branch}'`),
			);
		}
	});

program
	.command("top")
	.description("Checkout the topmost branch in the current stack path")
	.action(async () => {
		const result = await top(process.cwd());
		if (result.changed) {
			console.log(chalk.green(`✔ Switched to top branch '${result.branch}'`));
		} else {
			console.log(chalk.yellow(`⚠ Already at top branch '${result.branch}'`));
		}
	});

program
	.command("bottom")
	.description(
		"Checkout the first branch above the root in the current stack path",
	)
	.action(async () => {
		const result = await bottom(process.cwd());
		if (result.changed) {
			console.log(
				chalk.green(`✔ Switched to bottom stack branch '${result.branch}'`),
			);
		} else {
			console.log(
				chalk.yellow(`⚠ Already at bottom stack branch '${result.branch}'`),
			);
		}
	});

program
	.command("branch")
	.description("Show DubStack branch metadata")
	.addCommand(
		new Command("info")
			.description("Show tracked stack info for the current branch")
			.action(async () => {
				const info = await branchInfo(process.cwd());
				console.log(formatBranchInfo(info));
			}),
	);

program
	.command("sync")
	.description("Sync tracked branches with remote and reconcile divergence")
	.option(
		"--restack",
		"Restack branches after sync (disable with --no-restack)",
		true,
	)
	.option("-f, --force", "Skip prompts for destructive sync decisions")
	.option("-a, --all", "Sync all tracked stacks across trunks")
	.option("--no-interactive", "Disable prompts and use deterministic behavior")
	.action(
		async (options: {
			restack?: boolean;
			force?: boolean;
			all?: boolean;
			interactive?: boolean;
		}) => {
			await sync(process.cwd(), options);
		},
	);

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

program
	.command("submit")
	.description(
		"Push branches and create/update GitHub PRs for the current stack",
	)
	.option("--dry-run", "Print what would happen without executing")
	.addHelpText(
		"after",
		`
Examples:
  $ dub submit           Push and create/update PRs
  $ dub submit --dry-run Preview what would happen`,
	)
	.action(runSubmit);

program
	.command("ss")
	.description("Submit the current stack (alias for submit)")
	.option("--dry-run", "Print what would happen without executing")
	.action(runSubmit);

program
	.command("co")
	.argument("[branch]", "Branch to checkout (interactive if omitted)")
	.description("Checkout a branch (interactive picker if no name given)")
	.action(async (branch?: string) => {
		if (branch) {
			const result = await checkout(branch, process.cwd());
			console.log(chalk.green(`✔ Switched to '${result.branch}'`));
		} else {
			const result = await interactiveCheckout(process.cwd());
			if (result) {
				console.log(chalk.green(`✔ Switched to '${result.branch}'`));
			}
		}
	});

program
	.command("skills")
	.description("Manage DubStack agent skills")
	.addCommand(
		new Command("add")
			.description("Install agent skills (e.g. dubstack, dub-flow)")
			.argument("[skills...]", "Names of skills to install (default: all)")
			.option("-g, --global", "Install skills globally")
			.option("--dry-run", "Preview actions without installing")
			.action(async (skills, options) => {
				const { addSkills } = await import("./commands/skills");
				await addSkills(skills, options);
			}),
	)
	.addCommand(
		new Command("remove")
			.description("Remove agent skills")
			.argument("[skills...]", "Names of skills to remove (default: all)")
			.option("-g, --global", "Remove skills globally")
			.option("--dry-run", "Preview actions without removing")
			.action(async (skills, options) => {
				const { removeSkills } = await import("./commands/skills");
				await removeSkills(skills, options);
			}),
	);

program
	.command("modify")
	.alias("m")
	.description(
		"Modify the current branch by amending commits or creating new ones",
	)
	.option("-a, --all", "Stage all changes before committing")
	.option("-c, --commit", "Create a new commit instead of amending")
	.option("-e, --edit", "Open editor to edit the commit message")
	.option("-m, --message <message>", "Message for the new or amended commit")
	.option("-p, --patch", "Pick hunks to stage before committing")
	.option("-u, --update", "Stage all updates to tracked files")
	.option(
		"--interactive-rebase",
		"Start an interactive rebase on the branch commits",
	)
	// .option("--into <branch>", "Amend staged changes to the specified branch") // TODO: Implement --into
	// .option("--reset-author", "Set the author to the current user") // TODO: Implement --reset-author
	// .option("-v, --verbose", "Show unified diff") // TODO: Implement verbose
	.action(async (options) => {
		const { modify } = await import("./commands/modify");
		await modify(process.cwd(), options);
	});

async function runSubmit(options: { dryRun?: boolean }) {
	const result = await submit(process.cwd(), options.dryRun ?? false);

	if (result.pushed.length > 0) {
		console.log(
			chalk.green(
				`✔ Pushed ${result.pushed.length} branch(es), created ${result.created.length} PR(s), updated ${result.updated.length} PR(s)`,
			),
		);
		for (const branch of [...result.created, ...result.updated]) {
			console.log(chalk.dim(`  ↳ ${branch}`));
		}
	}
}

async function printLog(cwd: string) {
	const output = await log(cwd);
	const styled = output
		.replace(/\*(.+?) \(Current\)\*/g, chalk.bold.cyan("$1 (Current)"))
		.replace(/⚠ \(missing\)/g, chalk.yellow("⚠ (missing)"));
	console.log(styled);
}

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
