/**
 * Caller-facing lifecycle resources and capability results.
 *
 * These are Cursor domain types, not transport schemas. Wire payloads stay in
 * `schemas.ts` and remain loose. Public tools project into this model so an
 * internal integration change does not change caller vocabulary.
 *
 * Snapshots are fields or operation results, not a resource. Qualification and
 * mutation outcomes are results too: nothing here is persisted by this server.
 */

/** Evidence labels from `docs/cursor-capabilities.md`. */
export type CapabilityEvidence =
  | "documented"
  | "observed"
  | "client-code-derived"
  | "uncertain"
  | "unavailable"
  | "contradicted";

/**
 * How a capability is offered on the public surface.
 *
 * `manual-only` is a first-class outcome: the operation remains addressable and
 * fails with an owner-action residual rather than being omitted.
 */
export type CapabilityAvailability =
  | "supported"
  | "manual-only"
  | "uncertain"
  | "unavailable";

export type CapabilityAuthority =
  | "api-key"
  | "delegated-run"
  | "browser-session"
  | "repo-commit"
  | "admin";

export const LIFECYCLE_STAGES = [
  "inspect",
  "validate",
  "synchronize",
  "build",
  "qualify",
  "activate",
  "verify",
] as const;

export type LifecycleStage = (typeof LIFECYCLE_STAGES)[number];

export type OwnerAction =
  | "SAVE_ENVIRONMENT"
  | "TRIGGER_BUILD"
  | "CANCEL_BUILD"
  | "ACTIVATE_BUILD"
  | "DEACTIVATE_BUILD"
  | "RESTORE_ENVIRONMENT_VERSION"
  | "ROLLBACK_BUILD";

const BUILD_FAMILY_ACTIONS = new Set<OwnerAction>([
  "TRIGGER_BUILD",
  "CANCEL_BUILD",
  "ACTIVATE_BUILD",
  "DEACTIVATE_BUILD",
  "ROLLBACK_BUILD",
]);

const EXACT_BUILD_ACTIONS = new Set<OwnerAction>([
  "CANCEL_BUILD",
  "ACTIVATE_BUILD",
  "DEACTIVATE_BUILD",
  "ROLLBACK_BUILD",
]);

export type ResidualStatus =
  | "OWNER_ACTION_REQUIRED"
  | "CAPABILITY_UNCERTAIN"
  | "CAPABILITY_UNAVAILABLE"
  | "ACTIVE_STATE_UNKNOWN";

export type LayerResult = "passed" | "failed" | "indeterminate";

/**
 * Conservative follow-up eligibility from agent status.
 *
 * `IDLE` means follow-ups are accepted, not that a run succeeded. `ARCHIVED`
 * does not accept follow-ups. Any other value, including `ACTIVE` and unknown
 * future strings, is unknown: a follow-up may still fail with `agent_busy`.
 */
export type FollowUpAcceptance = "accepted" | "refused" | "unknown";

export function followUpAcceptance(status: string): FollowUpAcceptance {
  if (status === "IDLE") return "accepted";
  if (status === "ARCHIVED") return "refused";
  return "unknown";
}

/**
 * Active Build is a distinct slot, not "the newest SUCCEEDED row" and not the
 * Build the current run booted from.
 *
 * `readable: false` omits `buildId`: this authority cannot tell. `buildId: null`
 * is only legal when readable — it means the environment has no active Build.
 */
export type ActiveBuildRef =
  | { readable: false; buildId?: never }
  | { readable: true; buildId: string | null };

export interface Environment {
  environmentPublicId: string;
  name?: string;
  environmentVersionPublicId?: string;
  /** null => database-managed; a path => repository-file managed. */
  environmentJsonPath?: string | null;
  activeBuild: ActiveBuildRef;
}

export type EnvironmentManagedAs =
  | "database"
  | "repository-file"
  | "unknown";

export interface EnvironmentVersion {
  environmentPublicId: string;
  /** Public opaque id. Never the numeric Build-row `environmentVersionId`. */
  versionPublicId: string;
  managedAs: EnvironmentManagedAs;
}

/**
 * A prepared disk image. `status` is an open string; unknown values stay as
 * themselves and are never coerced to success.
 */
export interface Build {
  buildId: string;
  environmentPublicId: string;
  status: string;
  source?: string;
  triggerType?: string;
  failureType?: string | null;
  /** Snapshot field on this Build, not a Snapshot resource. */
  userFacingSnapshotId?: string | null;
  /** Numeric/internal. Never treat as `environmentVersionPublicId`. */
  environmentVersionId?: number;
  isDraft?: boolean;
}

export interface QualificationResult {
  buildId: string;
  preparedBuild: LayerResult;
  startExecution: LayerResult;
  taskShell: LayerResult;
}

export interface SnapshotOperationResult {
  snapshotOperationId: string;
  ready?: boolean;
}

export interface OwnerActionResidual {
  status: ResidualStatus;
  action: OwnerAction;
  authority: CapabilityAuthority;
  environmentPublicId?: string;
  environmentVersionPublicId?: string;
  buildId?: string;
  reason: string;
  requiredReadback: string;
  nextSteps: string[];
  activeBuildReadable?: boolean;
  expectedActiveBuildId?: string | null;
  supersededBuildId?: string;
  predecessorBuildId?: string | null;
  predecessorReason?: string;
}

export class CapabilityError extends Error {
  readonly residual: OwnerActionResidual;

  constructor(residual: OwnerActionResidual) {
    super(residual.reason);
    this.name = "CapabilityError";
    this.residual = residual;
  }
}

export function managedAsFromPath(
  environmentJsonPath: string | null | undefined,
): EnvironmentManagedAs {
  if (environmentJsonPath === undefined) return "unknown";
  if (environmentJsonPath === null) return "database";
  return "repository-file";
}

export function unreadableActiveBuild(): ActiveBuildRef {
  return { readable: false };
}

/**
 * Build `userFacingSnapshotId` and definition `snapshot` stay fields. A snapshot
 * *operation* (take/check) is a result, not a stored Snapshot type.
 */
export function snapshotField(build: Build): string | null | undefined {
  return build.userFacingSnapshotId;
}

export function ownerActionResidual(args: {
  status?: ResidualStatus;
  action: OwnerAction;
  authority: CapabilityAuthority;
  environmentPublicId?: string;
  environmentVersionPublicId?: string;
  buildId?: string;
  reason: string;
  requiredReadback: string;
  nextSteps: string[];
  supersededBuildId?: string;
  predecessorBuildId?: string | null;
  predecessorReason?: string;
}): OwnerActionResidual {
  const status = args.status ?? "OWNER_ACTION_REQUIRED";
  const residual: OwnerActionResidual = {
    status,
    action: args.action,
    authority: args.authority,
    reason: args.reason,
    requiredReadback: args.requiredReadback,
    nextSteps: args.nextSteps,
  };

  if (args.environmentPublicId !== undefined) {
    residual.environmentPublicId = args.environmentPublicId;
  }

  if (args.action === "RESTORE_ENVIRONMENT_VERSION" && args.buildId !== undefined) {
    throw new Error(
      "RESTORE_ENVIRONMENT_VERSION must not carry a buildId; Restore is not a Build operation",
    );
  }

  if (
    BUILD_FAMILY_ACTIONS.has(args.action) &&
    args.environmentVersionPublicId !== undefined
  ) {
    throw new Error(
      `${args.action} must not carry an environmentVersionPublicId; Build and environment-version operations are distinct`,
    );
  }

  if (EXACT_BUILD_ACTIONS.has(args.action) && args.buildId === undefined) {
    throw new Error(`${args.action} requires an exact buildId`);
  }

  if (
    args.action === "RESTORE_ENVIRONMENT_VERSION" &&
    args.environmentVersionPublicId === undefined
  ) {
    throw new Error(
      "RESTORE_ENVIRONMENT_VERSION requires an environmentVersionPublicId",
    );
  }

  if (args.environmentVersionPublicId !== undefined) {
    residual.environmentVersionPublicId = args.environmentVersionPublicId;
  }
  if (args.buildId !== undefined) residual.buildId = args.buildId;

  if (BUILD_FAMILY_ACTIONS.has(args.action)) {
    // Unreadable must not omit these: absence would look like "none active".
    residual.activeBuildReadable = false;
    residual.expectedActiveBuildId = null;
  }

  if (args.action === "ROLLBACK_BUILD") {
    if (args.supersededBuildId !== undefined) {
      residual.supersededBuildId = args.supersededBuildId;
    }
    residual.predecessorBuildId = args.predecessorBuildId ?? null;
    residual.predecessorReason =
      args.predecessorReason ??
      "No authoritative active-Build read exists, so a predecessor cannot be proven";
  }

  return residual;
}

/** Current-run / boot provenance is not the environment's active Build. */
export function isCurrentRunBuild(
  currentRunBuildId: string | undefined,
  active: ActiveBuildRef,
): boolean {
  if (!active.readable || active.buildId === undefined || active.buildId === null) {
    return false;
  }
  return currentRunBuildId !== undefined && currentRunBuildId === active.buildId;
}

export function isActivated(build: Build, active: ActiveBuildRef): boolean {
  if (!active.readable || active.buildId === undefined || active.buildId === null) {
    return false;
  }
  return build.buildId === active.buildId;
}
