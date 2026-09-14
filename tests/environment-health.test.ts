/**
 * Build health and toolchain freshness, against `docs/environment-freshness.md`.
 *
 * The judgements that decide whether a caller spends a Build: a skipped recurring
 * row is the schedule working and not a fault, a failure the history never
 * resolved is visible even when the newest row is not a failure, a version nobody
 * reported is missing evidence rather than drift, a `CONFIG_CHANGE` row is not
 * attributed to the definition because a secrets change emits one too, and an
 * unchanged environment produces the same no-op every time it is checked.
 */

import { describe, expect, it } from "vitest";
import {
  FRESHNESS_EXIT_CODES,
  assessBuildHealth,
  assessEnvironmentFreshness,
  assessSourceFreshness,
  assessToolchainFreshness,
  exitCodeFor,
  normalizeVersion,
  type HealthBuildRow,
} from "../src/environment-health.js";

const ENV = "env-public";
const NOW = 1_000_000_000;
const DAY = 86_400_000;

const row = (over: Partial<HealthBuildRow> = {}): HealthBuildRow => ({
  buildId: "bld-1",
  status: "SUCCEEDED",
  environmentPublicId: ENV,
  source: "SYSTEM",
  triggerType: "RECURRING",
  createdAtMs: NOW - DAY,
  completedAtMs: NOW - DAY + 159_000,
  ...over,
});

describe("Build health", () => {
  it("reports a healthy environment with the succeeding Build's age and trigger type", () => {
    const report = assessBuildHealth({
      asOfMs: NOW,
      conclusive: true,
      builds: [row({ buildId: "bld-new", completedAtMs: NOW - 2 * DAY })],
    });
    expect(report.health).toBe("HEALTHY");
    expect(report.latestSucceededBuildId).toBe("bld-new");
    expect(report.triggerType).toBe("RECURRING");
    expect(report.source).toBe("SYSTEM");
    expect(report.ageMs).toBe(2 * DAY);
    expect(report.ageDays).toBe(2);
    // HEALTHY is Build history. It is never activation.
    expect(report.activeBuild).toEqual({ readable: false });
    expect(report.reason).toContain("SUCCEEDED is not activation");
  });

  it("treats a skipped recurring Build as the schedule working, not a fault", () => {
    const report = assessBuildHealth({
      asOfMs: NOW,
      conclusive: true,
      builds: [
        row({ buildId: "bld-skip", status: "SKIPPED", createdAtMs: NOW - DAY }),
        row({ buildId: "bld-ok", createdAtMs: NOW - 3 * DAY, completedAtMs: NOW - 3 * DAY }),
      ],
    });
    expect(report.health).toBe("HEALTHY");
    expect(report.latestSucceededBuildId).toBe("bld-ok");
    expect(report.recentSkippedBuildIds).toEqual(["bld-skip"]);
    expect(report.counts.skipped).toBe(1);
    expect(report.reason).toContain("not a fault");
  });

  it("is FAILING when the newest terminal Build failed", () => {
    const report = assessBuildHealth({
      asOfMs: NOW,
      conclusive: true,
      builds: [
        row({ buildId: "bld-bad", status: "FAILED", failureType: "INSTALL_FAILED", createdAtMs: NOW - DAY }),
        row({ buildId: "bld-ok", createdAtMs: NOW - 3 * DAY }),
      ],
    });
    expect(report.health).toBe("FAILING");
    expect(report.latestTerminalBuildId).toBe("bld-bad");
    expect(report.recentFailedBuildIds).toEqual(["bld-bad"]);
    expect(report.reason).toContain("no idempotency key");
  });

  it("is DEGRADED when a failure was never resolved, even though the newest row is not a failure", () => {
    const report = assessBuildHealth({
      asOfMs: NOW,
      conclusive: true,
      builds: [
        row({ buildId: "bld-skip", status: "SKIPPED", createdAtMs: NOW - DAY }),
        row({ buildId: "bld-bad", status: "FAILED", createdAtMs: NOW - 2 * DAY }),
        row({ buildId: "bld-ok", createdAtMs: NOW - 3 * DAY }),
      ],
    });
    expect(report.health).toBe("DEGRADED");
    expect(report.reason).toContain("not the same as nothing having failed");
  });

  it("excludes draft rows, because a draft Build is never the environment's Build", () => {
    const report = assessBuildHealth({
      asOfMs: NOW,
      conclusive: true,
      builds: [
        row({ buildId: "bld-draft", status: "FAILED", isDraft: true, createdAtMs: NOW - 1_000 }),
        row({ buildId: "bld-ok", createdAtMs: NOW - 2 * DAY }),
      ],
    });
    expect(report.health).toBe("HEALTHY");
    expect(report.draftsExcluded).toBe(1);
    expect(report.recentFailedBuildIds).toEqual([]);
  });

  it("keeps an unrecognised status out of every verdict", () => {
    const report = assessBuildHealth({
      asOfMs: NOW,
      conclusive: true,
      builds: [row({ buildId: "bld-odd", status: "WARMING" })],
    });
    expect(report.health).toBe("UNKNOWN");
    expect(report.counts.unknown).toBe(1);
    expect(report.latestTerminalBuildId).toBeUndefined();
  });

  it("says so when further pages remained, so an absence is not concluded", () => {
    const report = assessBuildHealth({ asOfMs: NOW, builds: [], conclusive: false });
    expect(report.health).toBe("UNKNOWN");
    expect(report.reason).toContain("Further pages remained unread");
  });

  it("reports no age rather than a negative one when the row is newer than asOfMs", () => {
    const report = assessBuildHealth({
      asOfMs: NOW,
      conclusive: true,
      builds: [row({ completedAtMs: NOW + DAY })],
    });
    expect(report.latestSucceededAtMs).toBe(NOW + DAY);
    expect(report.ageMs).toBeUndefined();
    expect(report.ageDays).toBeUndefined();
  });

  it("orders by createdAtMs when every row carries one, and by list order otherwise", () => {
    expect(
      assessBuildHealth({ asOfMs: NOW, conclusive: true, builds: [row()] }).orderedBy,
    ).toBe("created-timestamp");
    expect(
      assessBuildHealth({
        asOfMs: NOW,
        conclusive: true,
        builds: [row({ createdAtMs: undefined })],
      }).orderedBy,
    ).toBe("list-order");
  });
});

describe("source freshness", () => {
  const health = assessBuildHealth({
    asOfMs: NOW,
    conclusive: true,
    builds: [row({ buildId: "bld-ok" })],
  });

  it("is unchanged when every comparable anchor matches", () => {
    const source = assessSourceFreshness({
      environmentJsonPath: null,
      baseline: { environmentVersionPublicId: "ver-1" },
      observed: { environmentVersionPublicId: "ver-1" },
      builds: [row({ buildId: "bld-ok" })],
      buildHealth: health,
    });
    expect(source.drift).toBe("unchanged");
    expect(source.managedAs).toBe("database");
    expect(source.comparisons).toHaveLength(1);
  });

  it("is changed when a declared anchor moved", () => {
    const source = assessSourceFreshness({
      environmentJsonPath: ".cursor/environment.json",
      baseline: { commitSha: "aaa111" },
      observed: { commitSha: "bbb222" },
      builds: [row({ buildId: "bld-ok" })],
      buildHealth: health,
    });
    expect(source.drift).toBe("changed");
    expect(source.managedAs).toBe("repository-file");
    expect(source.reason).toContain("commitSha");
  });

  it("separates nothing declared from a comparison it could not make", () => {
    expect(
      assessSourceFreshness({ buildHealth: health }).drift,
    ).toBe("undeclared");
    expect(
      assessSourceFreshness({
        baseline: { environmentVersionPublicId: "ver-1" },
        buildHealth: health,
      }).drift,
    ).toBe("unknown");
  });

  it("reports an unconsumed CONFIG_CHANGE Build without attributing it to the definition", () => {
    const rows = [
      row({ buildId: "bld-cfg", status: "IN_PROGRESS", triggerType: "CONFIG_CHANGE", createdAtMs: NOW - 1_000 }),
      row({ buildId: "bld-ok", createdAtMs: NOW - 3 * DAY }),
    ];
    const withPending = assessBuildHealth({ asOfMs: NOW, conclusive: true, builds: rows });
    const source = assessSourceFreshness({
      environmentJsonPath: null,
      baseline: { environmentVersionPublicId: "ver-1" },
      observed: { environmentVersionPublicId: "ver-1" },
      builds: rows,
      buildHealth: withPending,
    });
    expect(source.drift).toBe("changed");
    expect(source.pendingConfigurationChangeBuildIds).toEqual(["bld-cfg"]);
    expect(source.reason).toContain("a secrets change emits");
    expect(source.reason).toContain("not attributed to the definition");
  });

  it("does not call a CONFIG_CHANGE Build pending once a successful Build consumed it", () => {
    const rows = [
      row({ buildId: "bld-cfg", triggerType: "CONFIG_CHANGE", createdAtMs: NOW - 1_000 }),
    ];
    const consumed = assessBuildHealth({ asOfMs: NOW, conclusive: true, builds: rows });
    const source = assessSourceFreshness({
      environmentJsonPath: null,
      baseline: { environmentVersionPublicId: "ver-1" },
      observed: { environmentVersionPublicId: "ver-1" },
      builds: rows,
      buildHealth: consumed,
    });
    expect(source.pendingConfigurationChangeBuildIds).toEqual([]);
    expect(source.drift).toBe("unchanged");
  });
});

describe("toolchain freshness", () => {
  it("matches an installed version against a declared and an upstream one", () => {
    const result = assessToolchainFreshness({
      observed: [{ name: "node", version: "v20.11.0" }],
      expectations: [{ name: "node", expectedVersion: "20.11.0", upstreamVersion: "20.11.0" }],
    });
    expect(result.drift).toBe("matched");
    expect(result.findings[0]?.verdict).toBe("matched");
  });

  it("reports drift without claiming which version is newer", () => {
    const result = assessToolchainFreshness({
      observed: [{ name: "node", version: "20.11.0" }],
      expectations: [{ name: "node", upstreamVersion: "22.4.0" }],
    });
    expect(result.drift).toBe("drifted");
    expect(result.driftedNames).toEqual(["node"]);
    expect(result.findings[0]?.reason).toContain("which is newer is not established");
    expect(result.reason).toContain("recurring Build cannot observe this");
  });

  it("keeps an unreported version as missing evidence, never as a match or a drift", () => {
    const result = assessToolchainFreshness({
      observed: [],
      expectations: [{ name: "pnpm", expectedVersion: "9.1.0" }],
    });
    expect(result.drift).toBe("unknown");
    expect(result.unreportedNames).toEqual(["pnpm"]);
    expect(result.findings[0]?.verdict).toBe("unreported");
  });

  it("records an installed version nobody declared an expectation for", () => {
    const result = assessToolchainFreshness({
      observed: [{ name: "git", version: "2.39.3" }],
    });
    expect(result.drift).toBe("undeclared");
    expect(result.findings).toEqual([
      expect.objectContaining({ name: "git", verdict: "undeclared", observedVersion: "2.39.3" }),
    ]);
  });

  it("normalizes whitespace and one leading v, and nothing else", () => {
    expect(normalizeVersion(" v1.2.3 ")).toBe("1.2.3");
    expect(normalizeVersion("1.2.3")).toBe("1.2.3");
    expect(normalizeVersion("version 1.2.3")).toBe("version 1.2.3");
  });
});

describe("combined assessment", () => {
  const healthyRows = [row({ buildId: "bld-ok", completedAtMs: NOW - DAY })];

  const assess = (
    over: Omit<
      Parameters<typeof assessEnvironmentFreshness>[0],
      "environmentPublicId" | "asOfMs" | "buildsConclusive"
    >,
  ) =>
    assessEnvironmentFreshness({
      environmentPublicId: ENV,
      asOfMs: NOW,
      buildsConclusive: true,
      ...over,
    });

  it("is HEALTHY with exit code 0 and requests no Build", () => {
    const result = assess({
      builds: healthyRows,
      environmentJsonPath: null,
      baseline: { environmentVersionPublicId: "ver-1" },
      observed: { environmentVersionPublicId: "ver-1" },
      toolchainObserved: [{ name: "node", version: "20.11.0" }],
      toolchainExpectations: [{ name: "node", expectedVersion: "20.11.0" }],
    });
    expect(result.state).toBe("HEALTHY");
    expect(result.exitCode).toBe(0);
    expect(result.refresh.disposition).toBe("NOT_NEEDED");
    expect(result.refresh.dispatched).toBe(false);
    expect(result.refresh.reason).toContain("no-op");
  });

  it("is HEALTHY on Build evidence alone when nothing else was declared", () => {
    const result = assess({
      builds: healthyRows,
    });
    expect(result.state).toBe("HEALTHY");
    expect(result.source.drift).toBe("undeclared");
    expect(result.toolchain.drift).toBe("undeclared");
  });

  it("is STALE_TOOLCHAIN, and withholds the Build until one is requested", () => {
    const withheld = assess({
      builds: healthyRows,
      toolchainObserved: [{ name: "node", version: "20.11.0" }],
      toolchainExpectations: [{ name: "node", upstreamVersion: "22.4.0" }],
    });
    expect(withheld.state).toBe("STALE_TOOLCHAIN");
    expect(withheld.exitCode).toBe(10);
    expect(withheld.refresh.disposition).toBe("WITHHELD");

    const eligible = assess({
      builds: healthyRows,
      toolchainObserved: [{ name: "node", version: "20.11.0" }],
      toolchainExpectations: [{ name: "node", upstreamVersion: "22.4.0" }],
      refreshRequested: true,
    });
    expect(eligible.refresh.disposition).toBe("ELIGIBLE");
    expect(eligible.refresh.priorActiveBuild).toBe("unverified");
    expect(eligible.refresh.nextSteps.join(" ")).toContain("DRAFT Build");
  });

  it("is STALE_SOURCE for a changed definition, and refuses to build the unsaved change", () => {
    const result = assess({
      builds: healthyRows,
      environmentJsonPath: null,
      baseline: { definitionDigest: "sha256:aaa" },
      observed: { definitionDigest: "sha256:bbb" },
      toolchainObserved: [{ name: "node", version: "20.11.0" }],
      toolchainExpectations: [{ name: "node", upstreamVersion: "22.4.0" }],
      refreshRequested: true,
    });
    expect(result.state).toBe("STALE_SOURCE");
    expect(result.exitCode).toBe(11);
    // Toolchain drift is present too, and is still not a licence to build: a
    // Build from the saved configuration would not carry an unsaved change.
    expect(result.toolchain.drift).toBe("drifted");
    expect(result.refresh.disposition).toBe("WITHHELD");
    expect(result.refresh.reason).toContain("would not carry");
  });

  it("monitors an existing CONFIG_CHANGE Build instead of recommending another Save", () => {
    const result = assess({
      builds: [
        row({
          buildId: "bld-config",
          status: "IN_PROGRESS",
          triggerType: "CONFIG_CHANGE",
          createdAtMs: NOW - 1_000,
        }),
        row({ buildId: "bld-ok", createdAtMs: NOW - DAY }),
      ],
      toolchainObserved: [{ name: "node", version: "20.11.0" }],
      toolchainExpectations: [{ name: "node", upstreamVersion: "22.4.0" }],
      refreshRequested: true,
    });
    expect(result.state).toBe("STALE_SOURCE");
    expect(result.refresh.disposition).toBe("WITHHELD");
    expect(result.refresh.nextSteps.join(" ")).toContain("Monitor bld-config");
    expect(result.refresh.nextSteps.join(" ")).not.toContain("Persist the definition");
  });

  it("is BUILD_UNHEALTHY for a failed Build, and never re-triggers onto it", () => {
    const result = assess({
      builds: [row({ buildId: "bld-bad", status: "FAILED", failureType: "INSTALL_FAILED" })],
      toolchainObserved: [{ name: "node", version: "20.11.0" }],
      toolchainExpectations: [{ name: "node", upstreamVersion: "22.4.0" }],
      refreshRequested: true,
    });
    expect(result.state).toBe("BUILD_UNHEALTHY");
    expect(result.exitCode).toBe(20);
    expect(result.refresh.disposition).toBe("WITHHELD");
    expect(result.refresh.nextSteps.join(" ")).toContain("bld-bad");
    expect(result.refresh.nextSteps.join(" ")).toContain("active state remains unreadable");
  });

  it("is INDETERMINATE when an axis had incomplete evidence, and spends no Build on it", () => {
    const result = assess({
      builds: healthyRows,
      toolchainExpectations: [{ name: "pnpm", expectedVersion: "9.1.0" }],
      refreshRequested: true,
    });
    expect(result.state).toBe("INDETERMINATE");
    expect(result.exitCode).toBe(30);
    expect(result.refresh.disposition).toBe("WITHHELD");
    expect(result.refresh.reason).toContain("never spends one on an unproven condition");
    expect(result.refresh.nextSteps.join(" ")).toContain("pnpm");
  });

  it("returns the identical assessment for two consecutive checks of an unchanged environment", () => {
    const args = {
      environmentPublicId: ENV,
      asOfMs: NOW,
      buildsConclusive: true,
      builds: healthyRows,
      environmentJsonPath: null,
      baseline: { environmentVersionPublicId: "ver-1" },
      observed: { environmentVersionPublicId: "ver-1" },
      toolchainObserved: [{ name: "node", version: "20.11.0" }],
      toolchainExpectations: [{ name: "node", expectedVersion: "20.11.0" }],
      refreshRequested: true,
    };
    const first = assessEnvironmentFreshness(args);
    const second = assessEnvironmentFreshness(args);
    expect(second).toEqual(first);
    // Requesting a refresh does not make one happen: the environment is unchanged.
    expect(second.refresh.disposition).toBe("NOT_NEEDED");
    expect(second.refresh.dispatched).toBe(false);
  });

  it("keeps the active Build unreadable whatever the state", () => {
    const result = assess({ builds: healthyRows });
    expect(result.activeBuild).toEqual({ readable: false });
    expect(result.activeBuildReason).toContain("cannot read the environment's active Build");
  });
});

describe("scheduler exit codes", () => {
  it("maps every state to a stable code and never to 1", () => {
    expect(FRESHNESS_EXIT_CODES).toEqual({
      HEALTHY: 0,
      STALE_TOOLCHAIN: 10,
      STALE_SOURCE: 11,
      BUILD_UNHEALTHY: 20,
      INDETERMINATE: 30,
    });
    const codes = Object.values(FRESHNESS_EXIT_CODES);
    expect(codes).not.toContain(1);
    expect(new Set(codes).size).toBe(codes.length);
    expect(exitCodeFor("STALE_SOURCE")).toBe(11);
  });
});
