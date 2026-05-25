/**
 * Versioned JSON output contracts for every read-only `--json` command.
 *
 * The CLI and MCP server both depend on this module so the wire format stays
 * a single source of truth. Backward-compatible additions (new optional keys)
 * are minor; breaking changes bump {@link SCHEMA_VERSION} and ship a new
 * `LogJsonOutputV2`-style alias alongside the old one.
 *
 * Every wire envelope carries `schemaVersion: 1` so consumers can detect a
 * breaking-change upgrade by reading a single field.
 */

import type { BranchInfoResult } from '../commands/branch';
import type { ChildrenResult } from '../commands/children';
import type { DoctorResult } from '../commands/doctor';
import type { HistoryResult } from '../commands/history';
import type { LogJsonResult } from '../commands/log';
import type { MergeCheckResult } from '../commands/merge-check';
import type { ParentResult } from '../commands/parent';
import type { ReadyResult } from '../commands/ready';
import type { StatusResult } from '../commands/status';
import type { TrunkResult } from '../commands/trunk';

/** Numeric major version emitted on every `--json` envelope. */
export const SCHEMA_VERSION = 1 as const;
/** Literal type for {@link SCHEMA_VERSION}. */
export type SchemaVersion = typeof SCHEMA_VERSION;

/** Standard envelope for a `--json` failure (DubError with recovery hints). */
export interface JsonErrorEnvelope {
  schemaVersion: SchemaVersion;
  error: {
    message: string;
    recovery: string[];
  };
}

export type LogJsonOutput = LogJsonResult & { schemaVersion: SchemaVersion };
export type BranchInfoJsonOutput = BranchInfoResult & {
  schemaVersion: SchemaVersion;
};
export type DoctorJsonOutput = DoctorResult & { schemaVersion: SchemaVersion };
/**
 * `dub status --json`. {@link StatusResult} already carries `schemaVersion: 1`
 * inline, so the wire envelope and the in-process result are the same shape.
 */
export type StatusJsonOutput = StatusResult;
export type HistoryJsonOutput = HistoryResult & {
  schemaVersion: SchemaVersion;
};
export type ParentJsonOutput = ParentResult & { schemaVersion: SchemaVersion };
export type ChildrenJsonOutput = ChildrenResult & {
  schemaVersion: SchemaVersion;
};
export type TrunkJsonOutput = TrunkResult & { schemaVersion: SchemaVersion };
export type MergeCheckJsonOutput = MergeCheckResult & {
  schemaVersion: SchemaVersion;
};
export type ReadyJsonOutput = ReadyResult & { schemaVersion: SchemaVersion };

/**
 * Stamps `schemaVersion: 1` onto a command result. Centralised so each command
 * action stays a one-liner and the version literal lives in one place.
 *
 * Spread order is `payload` first, `schemaVersion` last: the constant always
 * wins so a payload that already carries a stale or wrong inline version is
 * normalised to the current {@link SCHEMA_VERSION} rather than silently
 * shadowing the helper. Status already includes `schemaVersion: 1` inline,
 * so wrapping it is idempotent today; if status's inline literal ever
 * disagrees with the canonical constant, the canonical constant wins.
 */
export function withSchemaVersion<T extends object>(
  payload: T,
): Omit<T, 'schemaVersion'> & { schemaVersion: SchemaVersion } {
  return { ...payload, schemaVersion: SCHEMA_VERSION };
}

/** Builds the JSON failure envelope for a `DubError`. */
export function jsonErrorEnvelope(
  message: string,
  recovery: string[] = [],
): JsonErrorEnvelope {
  return {
    schemaVersion: SCHEMA_VERSION,
    error: { message, recovery },
  };
}
