import { rmSync, unlinkSync } from "node:fs";

const dirsToRemove = ["src", "test", "skills", "docs/plans"];
for (const dir of dirsToRemove) {
  try {
    rmSync(dir, { recursive: true, force: true });
    console.log(`Removed ${dir}/`);
  } catch (e) {
    console.log(`Skipped ${dir}/ (not found)`);
  }
}

const filesToRemove = ["biome.jsonc"];
for (const f of filesToRemove) {
  try {
    unlinkSync(f);
    console.log(`Removed ${f}`);
  } catch (e) {
    console.log(`Skipped ${f} (not found)`);
  }
}

console.log("Cleanup complete");
