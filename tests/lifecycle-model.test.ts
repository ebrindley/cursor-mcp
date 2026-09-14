/**
 * Domain model and capability residuals for the lifecycle architecture.
 *
 * These tests walk the required scenarios against adapter classifications: they
 * pin identifier rules and fail-closed residuals, not a live integration.
 */

import { describe, expect, it } from "vitest";
import { READ_ONLY_POLICY } from "../src/config.js";
import {
  CapabilityError,
  LIFECYCLE_STAGES,
  followUpAcceptance,
  isActivated,
  isCurrentRunBuild,
  managedAsFromPath,
  ownerActionResidual,
  snapshotField,
  unreadableActiveBuild,
  type Build,
} from "../src/lifecycle-model.js";
import { isTerminal } from "../src/schemas.js";
import { fail } from "../src/tools/result.js";

const env = "env-public";
const build: Build = {
  buildId: "bld-1",
  environmentPublicId: env,
  status: "SUCCEEDED",
  userFacingSnapshotId: "bld-1",
  environmentVersionId: 123456,
  isDraft: true,
};

describe("domain resources", () => {
  it("treats a null environmentJsonPath as database-managed", () => {
    expect(managedAsFromPath(null)).toBe("database");
    expect(managedAsFromPath(".cursor/environment.json")).toBe("repository-file");
    expect(managedAsFromPath(undefined)).toBe("unknown");
  });

  it("does not treat a snapshot field as a Snapshot resource", () => {
    expect(snapshotField(build)).toBe("bld-1");
    expect(snapshotField({ ...build, userFacingSnapshotId: null })).toBeNull();
  });

  it("does not treat SUCCEEDED or current-run provenance as active", () => {
    const active = unreadableActiveBuild();
    expect(active).toEqual({ readable: false });
    expect(isActivated(build, active)).toBe(false);
    expect(isCurrentRunBuild("bld-1", active)).toBe(false);
    expect(
      isActivated(build, { readable: true, buildId: "bld-other" }),
    ).toBe(false);
    expect(
      isActivated(build, { readable: true, buildId: "bld-1" }),
    ).toBe(true);
    expect(
      isActivated(build, { readable: true, buildId: null }),
    ).toBe(false);
  });

  it("keeps the product lifecycle as atomic stages, not a stored workflow", () => {
    expect([...LIFECYCLE_STAGES]).toEqual([
      "inspect",
      "validate",
      "synchronize",
      "build",
      "qualify",
      "activate",
      "verify",
    ]);
  });
});

describe("agent follow-up eligibility", () => {
  it("treats IDLE as follow-up accepted, not as run completion", () => {
    expect(followUpAcceptance("IDLE")).toBe("accepted");
    expect(isTerminal("IDLE")).toBe(false);
  });

  it("refuses follow-up on ARCHIVED and does not claim ACTIVE is idle", () => {
    expect(followUpAcceptance("ARCHIVED")).toBe("refused");
    expect(followUpAcceptance("ACTIVE")).toBe("unknown");
  });

  it("leaves unknown future agent statuses unknown rather than mapping them to success", () => {
    expect(followUpAcceptance("HIBERNATING")).toBe("unknown");
  });
});

describe("capability residuals", () => {
  it("cold setup Save is an owner action with version readback", () => {
    const residual = ownerActionResidual({
      action: "SAVE_ENVIRONMENT",
      authority: "browser-session",
      environmentPublicId: env,
      environmentVersionPublicId: "ver-1",
      reason: "No published API-key, SDK, or delegated Cloud MCP Save operation.",
      requiredReadback: "new environmentVersionPublicId after owner Save",
      nextSteps: ["Save the environment in the Cursor dashboard"],
    });
    expect(residual.status).toBe("OWNER_ACTION_REQUIRED");
    expect(residual.buildId).toBeUndefined();
    expect(residual.environmentVersionPublicId).toBe("ver-1");
  });

  it("failed Builds do not produce an activate residual", () => {
    const failed: Build = { ...build, status: "FAILED", isDraft: false };
    expect(isActivated(failed, unreadableActiveBuild())).toBe(false);
  });

  it("Build cancel is CANCEL_BUILD, never a run cancel", () => {
    const residual = ownerActionResidual({
      action: "CANCEL_BUILD",
      authority: "browser-session",
      environmentPublicId: env,
      buildId: "bld-1",
      reason:
        "No published API-key, SDK, or delegated Cloud MCP Build-cancel operation. Run cancellation is a different resource.",
      requiredReadback:
        "list-environment-builds row for that buildId with a terminal cancelled status",
      nextSteps: ["Cancel the Build from the environment dashboard"],
    });
    expect(residual.action).toBe("CANCEL_BUILD");
    expect(residual.activeBuildReadable).toBe(false);
    expect(residual.expectedActiveBuildId).toBeNull();
  });

  it("activation residual does not treat SUCCEEDED as evidence of activation", () => {
    const residual = ownerActionResidual({
      action: "ACTIVATE_BUILD",
      authority: "browser-session",
      environmentPublicId: env,
      buildId: build.buildId,
      reason:
        "No activate operation and no authoritative active-Build read on supported authorities.",
      requiredReadback: "authoritative active Build equal to the exact buildId",
      nextSteps: ["Activate the Build from the environment dashboard"],
    });
    expect(residual.status).toBe("OWNER_ACTION_REQUIRED");
    expect(residual.activeBuildReadable).toBe(false);
    expect(residual.expectedActiveBuildId).toBeNull();
    expect(residual).not.toHaveProperty("userFacingSnapshotId");
    expect(build.status).toBe("SUCCEEDED");
  });

  it("rollback is a Build action and Restore is not interchangeable with it", () => {
    const rollback = ownerActionResidual({
      action: "ROLLBACK_BUILD",
      authority: "browser-session",
      environmentPublicId: env,
      buildId: "bld-prev",
      supersededBuildId: "bld-1",
      reason: "No rollback primitive on supported authorities.",
      requiredReadback: "authoritative active Build equal to the predecessor buildId",
      nextSteps: ["Activate the prior Build from the environment dashboard"],
    });
    expect(rollback.predecessorBuildId).toBeNull();
    expect(rollback.supersededBuildId).toBe("bld-1");
    expect(rollback.environmentVersionPublicId).toBeUndefined();

    const restore = ownerActionResidual({
      action: "RESTORE_ENVIRONMENT_VERSION",
      authority: "browser-session",
      environmentPublicId: env,
      environmentVersionPublicId: "ver-prev",
      reason: "No Restore contract on supported authorities.",
      requiredReadback: "environmentVersionPublicId equal to the restored version",
      nextSteps: ["Restore the version from environment version history"],
    });
    expect(restore.buildId).toBeUndefined();
    expect(restore.activeBuildReadable).toBeUndefined();
  });

  it("refuses to put a buildId on Restore", () => {
    expect(() =>
      ownerActionResidual({
        action: "RESTORE_ENVIRONMENT_VERSION",
        authority: "browser-session",
        buildId: "bld-1",
        reason: "x",
        requiredReadback: "y",
        nextSteps: [],
      }),
    ).toThrow(/must not carry a buildId/);
  });

  it("requires the exact identifier family for owner actions", () => {
    const common = {
      authority: "browser-session" as const,
      reason: "unsupported on this authority",
      requiredReadback: "authoritative readback",
      nextSteps: [],
    };

    expect(() =>
      ownerActionResidual({ action: "ACTIVATE_BUILD", ...common }),
    ).toThrow(/requires an exact buildId/);
    expect(() =>
      ownerActionResidual({
        action: "CANCEL_BUILD",
        buildId: "bld-1",
        environmentVersionPublicId: "ver-1",
        ...common,
      }),
    ).toThrow(/must not carry an environmentVersionPublicId/);
    expect(() =>
      ownerActionResidual({ action: "RESTORE_ENVIRONMENT_VERSION", ...common }),
    ).toThrow(/requires an environmentVersionPublicId/);
  });

  it("surfaces residuals as structured tool failures, not generic errors", () => {
    const residual = ownerActionResidual({
      action: "TRIGGER_BUILD",
      authority: "browser-session",
      environmentPublicId: env,
      reason: "Host-wide manual Build is not available on this authority.",
      requiredReadback: "Build row for the new buildId",
      nextSteps: ["Trigger the Build from the dashboard"],
    });
    const result = fail(new CapabilityError(residual), READ_ONLY_POLICY);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      status: "OWNER_ACTION_REQUIRED",
      action: "TRIGGER_BUILD",
      environmentPublicId: env,
    });
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain("TRIGGER_BUILD");
    expect(text).not.toContain("CURSOR_UNTRUSTED>>>");
  });
});
