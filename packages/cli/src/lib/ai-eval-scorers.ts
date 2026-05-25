export interface EvalScore {
  score: number;
  metadata?: Record<string, unknown>;
}

export interface BranchNamingOutput {
  branch: string;
}

export interface BranchNamingExpected {
  prefix: string;
  requiredScopeTerms: readonly string[];
}

export interface PrDescriptionOutput {
  prDescription: string;
}

export interface PrDescriptionExpected {
  templateHeadings?: readonly string[];
  requiredKeywords: readonly string[];
  forbiddenKeywords?: readonly string[];
}

export interface ConflictResolutionOutput {
  resolvedContent: string;
  explanation: string;
}

export interface ConflictResolutionExpected {
  preservedSnippets: readonly string[];
  forbiddenSnippets?: readonly string[];
}

export interface SplitProposalOutput {
  splits: ReadonlyArray<{
    branch: string;
    files: readonly string[];
    summary: string;
  }>;
}

export interface SplitProposalExpected {
  knownFiles: readonly string[];
  minSplits?: number;
}

export interface AbsorbTargetOutput {
  assignments: ReadonlyArray<{
    wipSha: string;
    targetSha: string | null;
  }>;
}

export interface AbsorbTargetExpected {
  assignments: ReadonlyArray<{
    wipSha: string;
    targetSha: string | null;
  }>;
}

export function scoreBranchNaming(
  output: BranchNamingOutput,
  expected: BranchNamingExpected,
): EvalScore {
  const branch = output.branch.trim();
  const matchesPrefix = branch.startsWith(expected.prefix);
  const validShape = /^[a-z0-9]+(?:[/-][a-z0-9]+)*$/.test(branch);
  const matchedScopeTerms = expected.requiredScopeTerms.filter((term) =>
    branch.includes(term.toLowerCase()),
  );
  const scopeScore =
    expected.requiredScopeTerms.length === 0
      ? 1
      : matchedScopeTerms.length / expected.requiredScopeTerms.length;

  return {
    score:
      (matchesPrefix ? 0.4 : 0) + (validShape ? 0.3 : 0) + scopeScore * 0.3,
    metadata: {
      branch,
      matchesPrefix,
      validShape,
      matchedScopeTerms,
    },
  };
}

export function scorePrDescription(
  output: PrDescriptionOutput,
  expected: PrDescriptionExpected,
): EvalScore {
  const description = output.prDescription.trim();
  if (description.length === 0) {
    return { score: 0, metadata: { reason: 'empty' } };
  }
  if (description.includes('```')) {
    return { score: 0, metadata: { reason: 'markdown-fence' } };
  }

  const headings = expected.templateHeadings ?? [];
  let cursor = 0;
  const headingsOrdered = headings.every((heading) => {
    const index = description.indexOf(heading, cursor);
    if (index === -1) return false;
    cursor = index + heading.length;
    return true;
  });

  const haystack = description.toLowerCase();
  const matchedRequired = expected.requiredKeywords.filter((keyword) =>
    haystack.includes(keyword.toLowerCase()),
  );
  const matchedForbidden = (expected.forbiddenKeywords ?? []).filter(
    (keyword) => haystack.includes(keyword.toLowerCase()),
  );
  const requiredScore =
    expected.requiredKeywords.length === 0
      ? 1
      : matchedRequired.length / expected.requiredKeywords.length;
  const forbiddenScore = matchedForbidden.length === 0 ? 1 : 0;
  const templateScore = headings.length === 0 || headingsOrdered ? 1 : 0;

  return {
    score: requiredScore * forbiddenScore * templateScore,
    metadata: {
      matchedRequired,
      matchedForbidden,
      headings,
      headingsOrdered,
    },
  };
}

export function scoreConflictResolution(
  output: ConflictResolutionOutput,
  expected: ConflictResolutionExpected,
): EvalScore {
  const haystack = `${output.resolvedContent}\n${output.explanation}`;
  const matchedPreserved = expected.preservedSnippets.filter((snippet) =>
    haystack.includes(snippet),
  );
  const matchedForbidden = (expected.forbiddenSnippets ?? []).filter(
    (snippet) => output.resolvedContent.includes(snippet),
  );
  const preservedScore =
    expected.preservedSnippets.length === 0
      ? 1
      : matchedPreserved.length / expected.preservedSnippets.length;
  const forbiddenScore = matchedForbidden.length === 0 ? 1 : 0;
  const markerFree =
    output.resolvedContent.includes('<<<<<<<') ||
    output.resolvedContent.includes('=======') ||
    output.resolvedContent.includes('>>>>>>>')
      ? 0
      : 1;

  return {
    score: preservedScore * forbiddenScore * markerFree,
    metadata: {
      matchedPreserved,
      matchedForbidden,
      markerFree: markerFree === 1,
    },
  };
}

export function scoreSplitProposal(
  output: SplitProposalOutput,
  expected: SplitProposalExpected,
): EvalScore {
  const known = new Set(expected.knownFiles);
  const assignedFiles = output.splits.flatMap((split) => split.files);
  const assigned = new Set(assignedFiles);
  const unknownFiles = assignedFiles.filter((file) => !known.has(file));
  const duplicateFiles = assignedFiles.filter(
    (file, index) => assignedFiles.indexOf(file) !== index,
  );
  const missingFiles = expected.knownFiles.filter(
    (file) => !assigned.has(file),
  );
  const branchNamesValid = output.splits.every(
    (split) =>
      /^[a-z0-9]+(?:[/-][a-z0-9]+)*$/.test(split.branch) &&
      split.summary.trim().length > 0,
  );
  const enoughSplits = output.splits.length >= (expected.minSplits ?? 1);
  const valid =
    unknownFiles.length === 0 &&
    duplicateFiles.length === 0 &&
    missingFiles.length === 0 &&
    branchNamesValid &&
    enoughSplits;

  return {
    score: valid ? 1 : 0,
    metadata: {
      unknownFiles,
      duplicateFiles,
      missingFiles,
      branchNamesValid,
      enoughSplits,
    },
  };
}

export function scoreAbsorbTargets(
  output: AbsorbTargetOutput,
  expected: AbsorbTargetExpected,
): EvalScore {
  const expectedTargets = new Map(
    expected.assignments.map((assignment) => [
      assignment.wipSha,
      assignment.targetSha,
    ]),
  );
  const matched = output.assignments.filter(
    (assignment) =>
      expectedTargets.get(assignment.wipSha) === assignment.targetSha,
  );
  const unexpected = output.assignments.filter(
    (assignment) => !expectedTargets.has(assignment.wipSha),
  );
  const score =
    expectedTargets.size === 0 ? 1 : matched.length / expectedTargets.size;

  return {
    score: unexpected.length === 0 ? score : 0,
    metadata: {
      matched: matched.map((assignment) => assignment.wipSha),
      unexpected: unexpected.map((assignment) => assignment.wipSha),
    },
  };
}

export function parseEvalJudgeResponse(text: string): {
  score: number;
  rationale: string;
} {
  const match = text.trim().match(/\{[\s\S]*\}/);
  if (!match) {
    return {
      score: 0,
      rationale: `Judge returned non-JSON output: ${text.slice(0, 200)}`,
    };
  }

  try {
    const parsed = JSON.parse(match[0]) as {
      score?: unknown;
      rationale?: unknown;
    };
    return {
      score:
        typeof parsed.score === 'number'
          ? Math.max(0, Math.min(100, parsed.score))
          : 0,
      rationale:
        typeof parsed.rationale === 'string'
          ? parsed.rationale
          : 'Judge did not provide a rationale.',
    };
  } catch {
    return {
      score: 0,
      rationale: `Judge returned invalid JSON: ${text.slice(0, 200)}`,
    };
  }
}

export function scoreEvalJudgeResponse(text: string): EvalScore {
  const parsed = parseEvalJudgeResponse(text);
  return {
    score: parsed.score / 100,
    metadata: { rationale: parsed.rationale },
  };
}
