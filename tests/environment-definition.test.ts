/**
 * Environment Definition: parsing, schema conformance, safety, diff, and the
 * synchronization request.
 *
 * Fixtures and contract examples are authored for these tests. They exercise
 * the environment fields documented on 2026-09-07; no upstream schema file is
 * bundled. These tests do not detect future changes to Cursor's live schema.
 */

import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEFINITION_PROPERTIES,
  MAX_DEFINITION_BYTES,
  MAX_DIFF_CHANGES,
  EnvironmentDefinitionSchema,
  absentDefinition,
  buildSynchronizationRequest,
  diffDefinitions,
  normalizeDefinition,
  parseJsonc,
  readLocalDefinition,
  resolveDefinitionPath,
  summarizeScript,
  validateDefinition,
  type EnvironmentDefinition,
} from "../src/environment-definition.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "environment");

const fixture = (name: string) => readFileSync(join(FIXTURES, name), "utf8");

const validate = (name: string) =>
  validateDefinition({
    text: fixture(name),
    source: "local-file",
    origin: `fixture ${name}`,
  });

const definitionOf = (name: string): EnvironmentDefinition => {
  const result = validate(name);
  if (result.definition === undefined) {
    throw new Error(`${name} did not validate: ${JSON.stringify(result.errors)}`);
  }
  return result.definition;
};

describe("JSONC parsing", () => {
  it("accepts comments, as the published schema declares", () => {
    const result = parseJsonc('{\n  // a note\n  "name": "x" /* and another */\n}');
    expect(result).toEqual({ ok: true, value: { name: "x" } });
  });

  it("does not treat comment markers inside a string as comments", () => {
    const result = parseJsonc('{"install": "curl https://example.test/a // b /* c"}');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      install: "curl https://example.test/a // b /* c",
    });
  });

  it("keeps an escaped quote from ending the string", () => {
    const result = parseJsonc('{"install": "echo \\"// not a comment\\""}');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ install: 'echo "// not a comment"' });
  });

  it("names a trailing comma rather than reporting an opaque token error", () => {
    const result = parseJsonc(fixture("invalid-trailing-comma.jsonc"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issue.code).toBe("JSONC_TRAILING_COMMA");
  });

  it("reports an unterminated block comment as its own failure", () => {
    const result = parseJsonc('{ /* never closed\n  "name": "x"\n}');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issue.code).toBe("JSONC_UNTERMINATED_COMMENT");
  });

  it("ignores structure that exists only inside a comment", () => {
    const result = parseJsonc('{\n// "name": "commented-out",\n"name": "x"\n/* } */\n}');
    expect(result).toEqual({ ok: true, value: { name: "x" } });
  });
});

describe("environment contract reviewed 2026-09-07", () => {
  it("accepts the documented September fields and preserves their values", () => {
    const definition = {
      image: "registry.example.test/project/base:stable",
      egressAllowlist: ["packages.example.test"],
      egressMode: "network_settings_only",
      chromeExecutablePath: "/opt/browser/chrome",
      enable_testing: "false",
    };
    const parsed = EnvironmentDefinitionSchema.parse(definition);
    expect(parsed).toEqual(definition);
    expect(DEFINITION_PROPERTIES).toEqual(expect.arrayContaining(Object.keys(definition)));
    expect(validateDefinition({ text: JSON.stringify(definition), source: "proposed", origin: "test" }).status).toBe("valid");
  });

  it.each([true, false, "true", "false"])("accepts testing flag %s", (value) => {
    expect(EnvironmentDefinitionSchema.safeParse({ enable_testing: value }).success).toBe(true);
  });

  it.each([
    { egressMode: "unrecognized" }, { egressAllowlist: [12] },
    { chromeExecutablePath: false }, { enable_testing: "yes" }, { image: 7 },
  ])("rejects mistyped September fields: %j", (definition) => {
    expect(EnvironmentDefinitionSchema.safeParse(definition).success).toBe(false);
  });

  it("rejects editor metadata the strict published root does not declare", () => {
    const result = validateDefinition({
      text: '{"$schema":"https://www.cursor.com/schemas/environment.schema.json"}',
      source: "proposed",
      origin: "test",
    });
    expect(result.status).toBe("invalid");
    expect(JSON.stringify(result.errors)).toContain("$schema");
  });

  it("rejects an unknown top-level property as a schema error", () => {
    const result = validate("invalid-unknown-property.json");
    expect(result.status).toBe("invalid");
    expect(result.safety).toEqual([]);
    // The unknown key is named in the issue, wherever the validator puts it.
    expect(JSON.stringify(result.errors)).toContain("envVars");
  });

  it("requires a Dockerfile source and rejects unknown build keys", () => {
    expect(
      EnvironmentDefinitionSchema.safeParse({ build: { context: "." } }).success,
    ).toBe(false);
    expect(
      EnvironmentDefinitionSchema.safeParse({
        build: { dockerfile: "Dockerfile", target: "dev" },
      }).success,
    ).toBe(false);
    expect(
      EnvironmentDefinitionSchema.safeParse({ build: { dockerfile: "Dockerfile" } })
        .success,
    ).toBe(true);
  });

  it("accepts file, inline, and both Dockerfile sources under the any-of contract", () => {
    for (const build of [
      { dockerfileContents: "FROM scratch\nCOPY . /workspace" },
      { dockerfile: "Dockerfile", dockerfileContents: "FROM scratch" },
    ]) {
      const parsed = EnvironmentDefinitionSchema.parse({ build });
      expect(parsed.build).toEqual(build);
      const normalized = normalizeDefinition(parsed);
      expect(normalized.container.dockerfileContents?.digest).toMatch(/^sha256:/);
      expect(normalized.container.context?.repoRelative).toBe(".cursor");
    }
    expect(EnvironmentDefinitionSchema.safeParse({ build: { dockerfileContents: 3 } }).success).toBe(false);
  });

  it("bounds a port and requires it", () => {
    expect(
      EnvironmentDefinitionSchema.safeParse({ ports: [{ port: 65536 }] }).success,
    ).toBe(false);
    expect(EnvironmentDefinitionSchema.safeParse({ ports: [{ port: 0 }] }).success).toBe(
      false,
    );
    expect(EnvironmentDefinitionSchema.safeParse({ ports: [{ name: "x" }] }).success).toBe(
      false,
    );
    expect(EnvironmentDefinitionSchema.safeParse({ ports: [{ port: 3000 }] }).success).toBe(
      true,
    );
  });

  it("requires serverUrl or command on an MCP allowlist entry, and nothing unknown", () => {
    expect(
      EnvironmentDefinitionSchema.safeParse({ mcpServerAllowlist: [{ name: "x" }] })
        .success,
    ).toBe(false);
    expect(
      EnvironmentDefinitionSchema.safeParse({
        mcpServerAllowlist: [{ command: "x", env: { A: "b" } }],
      }).success,
    ).toBe(false);
    expect(
      EnvironmentDefinitionSchema.safeParse({
        mcpServerAllowlist: [{ serverUrl: "https://mcp.example.test" }],
      }).success,
    ).toBe(true);
  });

  it("validates a fully commented definition and a sanitized observed one", () => {
    expect(validate("valid-commented.jsonc").status).toBe("valid");
    expect(validate("observed-sanitized.json").status).toBe("valid");
  });

  it("accepts both documented terminal forms", () => {
    const legacy = normalizeDefinition(definitionOf("legacy-terminals.json"));
    expect(legacy.terminals.map((terminal) => terminal.form)).toEqual([
      "array",
      "array",
    ]);
    expect(legacy.terminals.map((terminal) => terminal.name)).toEqual(["api", "worker"]);

    const current = normalizeDefinition(definitionOf("valid-commented.jsonc"));
    expect(current.terminals.map((terminal) => terminal.form)).toEqual(["object"]);
  });

  it("refuses a definition larger than the byte limit before parsing it", () => {
    const result = validateDefinition({
      text: `{"install": "${"x".repeat(MAX_DEFINITION_BYTES)}"}`,
      source: "proposed",
      origin: "test",
    });
    expect(result.status).toBe("invalid");
    expect(result.errors[0]?.code).toBe("DEFINITION_TOO_LARGE");
  });
});

describe("path resolution", () => {
  it("resolves a relative path against the .cursor directory", () => {
    expect(resolveDefinitionPath("Dockerfile")).toEqual({
      declared: "Dockerfile",
      repoRelative: ".cursor/Dockerfile",
      absolute: false,
      escapesRepositoryRoot: false,
    });
  });

  it("treats `.`, `./`, and `..` as the repository root", () => {
    expect(resolveDefinitionPath(".").repoRelative).toBe(".");
    expect(resolveDefinitionPath("./").repoRelative).toBe(".");
    expect(resolveDefinitionPath("..").repoRelative).toBe(".");
    expect(resolveDefinitionPath("../Dockerfile").repoRelative).toBe("Dockerfile");
  });

  it("reports a path that climbs above the repository root", () => {
    const resolved = resolveDefinitionPath("../../outside");
    expect(resolved.escapesRepositoryRoot).toBe(true);
  });

  it("reports an absolute path as declared, with no repository-relative form", () => {
    const resolved = resolveDefinitionPath("/opt/example/Dockerfile");
    expect(resolved.absolute).toBe(true);
    expect(resolved.repoRelative).toBeUndefined();
  });
});

describe("normalized inspection", () => {
  it("summarizes scripts by digest, never by text", () => {
    const normalized = normalizeDefinition(definitionOf("observed-sanitized.json"));
    expect(normalized.install?.digest).toMatch(/^sha256:[0-9a-f]{12}$/);
    expect(JSON.stringify(normalized)).not.toContain("npm ci");
    expect(normalized.install?.strictShellMode).toBe(true);
  });

  it("classifies MCP policy without reading an empty allowlist as a block", () => {
    const inherit = normalizeDefinition(
      definitionOf("observed-sanitized.json"),
    ).mcp;
    expect(inherit.policy).toBe("inherit");

    const allowlist = normalizeDefinition(definitionOf("valid-commented.jsonc")).mcp;
    expect(allowlist.policy).toBe("allowlist");
    expect(allowlist.entries.map((entry) => entry.kind)).toEqual(["http", "stdio"]);
    expect(allowlist.entries[0]?.allowsAllTools).toBe(false);
    expect(allowlist.entries[1]?.allowsAllTools).toBe(true);
    expect(JSON.stringify(allowlist)).not.toContain("mcp.example.test");

    const blocked = normalizeDefinition({ disableAllMcpServers: true }).mcp;
    expect(blocked.policy).toBe("blocked");
    const emptyList = normalizeDefinition({ mcpServerAllowlist: [] }).mcp;
    expect(emptyList.policy).toBe("inherit");
  });

  it("resolves container build paths and the snapshot input", () => {
    const normalized = normalizeDefinition(definitionOf("valid-commented.jsonc"));
    expect(normalized.container.dockerfile?.repoRelative).toBe(".cursor/Dockerfile");
    expect(normalized.container.context?.repoRelative).toBe(".");
    expect(normalized.snapshot).toEqual({
      baseSnapshotId: "snapshot-placeholder",
      // `snapshot` is set, so it outranks this document's own `build`.
      base: "snapshot",
      agentCanUpdateSnapshotConfigured: false,
      agentCanUpdateSnapshot: false,
    });
  });

  // Cursor's rules, not ours: `snapshot` takes precedence over `build` and
  // `image`; the permission defaults to true on a snapshot or default base; and
  // it is false on a `build` or `image` base whatever the document asked for.
  // Reading the raw field as `=== true` got the first and last of those wrong.
  it.each([
    { document: {}, base: "default", configured: null, effective: true },
    {
      document: { agentCanUpdateSnapshot: false },
      base: "default",
      configured: false,
      effective: false,
    },
    { document: { snapshot: "snap-1" }, base: "snapshot", configured: null, effective: true },
    {
      document: { snapshot: "snap-1", agentCanUpdateSnapshot: false },
      base: "snapshot",
      configured: false,
      effective: false,
    },
    {
      document: { image: "registry.example.test/base" },
      base: "image",
      configured: null,
      effective: false,
    },
    {
      document: { image: "registry.example.test/base", agentCanUpdateSnapshot: true },
      base: "image",
      configured: true,
      effective: false,
    },
    {
      document: { build: { dockerfile: "Dockerfile" } },
      base: "build",
      configured: null,
      effective: false,
    },
    {
      document: { build: { dockerfile: "Dockerfile" }, agentCanUpdateSnapshot: true },
      base: "build",
      configured: true,
      effective: false,
    },
    {
      document: {
        snapshot: "snap-1",
        build: { dockerfile: "Dockerfile" },
        image: "registry.example.test/base",
      },
      base: "snapshot",
      configured: null,
      effective: true,
    },
  ])(
    "separates the configured snapshot permission from the effective one: %j",
    ({ document, base, configured, effective }) => {
      const normalized = normalizeDefinition(
        EnvironmentDefinitionSchema.parse(document),
      );
      expect(normalized.snapshot.base).toBe(base);
      expect(normalized.snapshot.agentCanUpdateSnapshotConfigured).toBe(configured);
      expect(normalized.snapshot.agentCanUpdateSnapshot).toBe(effective);
    },
  );

  it("reports Cursor's omitted build-context default as .cursor", () => {
    const normalized = normalizeDefinition({
      build: { dockerfile: "Dockerfile" },
    });
    expect(normalized.container.context).toEqual({
      declared: "",
      repoRelative: ".cursor",
      absolute: false,
      escapesRepositoryRoot: false,
      defaulted: true,
    });
  });

  it("summarizes new string fields without echoing their contents", () => {
    const definition = EnvironmentDefinitionSchema.parse({
      build: { dockerfileContents: "FROM scratch\nRUN echo PRIVATE_SENTINEL" },
      image: "registry.example.test/PRIVATE_SENTINEL",
      egressAllowlist: ["PRIVATE_SENTINEL.example.test"],
      egressMode: "network_settings_only",
      chromeExecutablePath: "/PRIVATE_SENTINEL/chrome",
      enable_testing: "false",
    });
    const normalized = normalizeDefinition(definition);
    expect(normalized.container.dockerfile).toBeNull();
    expect(normalized.container.dockerfileContents?.lines).toBe(2);
    expect(normalized.network.allowlistCount).toBe(1);
    expect(normalized.testing.enabled).toBe(false);
    expect(normalized.network.egressMode).toBe("network_settings_only");
    expect(JSON.stringify(normalized)).not.toContain("PRIVATE_SENTINEL");
    const changes = diffDefinitions({}, definition).changes;
    expect(changes.some((change) => change.path === "build.dockerfileContents")).toBe(true);
    expect(changes.every((change) => change.redacted)).toBe(true);
    expect(JSON.stringify(changes)).not.toContain("PRIVATE_SENTINEL");
  });

  it("detects the three shell options independently", () => {
    expect(summarizeScript("set -e\nmake").strictShellMode).toBe(false);
    expect(summarizeScript("set -euo pipefail\nmake").strictShellMode).toBe(true);
    expect(
      summarizeScript("set -o errexit\nset -o nounset\nset -o pipefail\nmake")
        .strictShellMode,
    ).toBe(true);
  });
});

describe("safety findings", () => {
  const result = validate("unsafe-scripts.json");

  it("applies existing safety analysis to inline Dockerfile commands", () => {
    const result = validateDefinition({
      text: JSON.stringify({ build: { dockerfileContents: "FROM scratch\nRUN git push origin main" } }),
      source: "proposed", origin: "test",
    });
    expect(result.status).toBe("valid");
    expect(result.safety).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "UNSAFE_STATE_UPDATE", path: "build.dockerfileContents", line: 2 }),
    ]));
    expect(JSON.stringify(result.safety)).not.toContain("git push");
  });

  it("keeps safety separate from schema legality", () => {
    expect(result.status).toBe("valid");
    expect(result.errors).toEqual([]);
    expect(result.safety.length).toBeGreaterThan(0);
  });

  it("flags credential persistence and unsafe state updates as warnings", () => {
    const warnings = result.safety
      .filter((finding) => finding.severity === "warning")
      .map((finding) => finding.code);
    expect(warnings).toContain("CREDENTIAL_PERSISTENCE");
    expect(warnings).toContain("CREDENTIAL_ENV_PERSISTENCE");
    expect(warnings).toContain("UNSAFE_STATE_UPDATE");
    expect(warnings).toContain("SNAPSHOT_UPDATE_AUTHORITY");
  });

  it("advises on the effective snapshot permission, not the written one", () => {
    const defaulted = validateDefinition({
      text: JSON.stringify({ snapshot: "snap-1" }),
      source: "proposed",
      origin: "test",
    });
    const finding = defaulted.safety.find(
      (entry) => entry.code === "SNAPSHOT_UPDATE_AUTHORITY",
    );
    // The document never mentions the permission; Cursor grants it anyway, and
    // the advisory says which of the two it is describing.
    expect(finding?.label).toContain("unset and defaults to true on a snapshot base");

    const ignored = validateDefinition({
      text: JSON.stringify({
        image: "registry.example.test/base",
        agentCanUpdateSnapshot: true,
      }),
      source: "proposed",
      origin: "test",
    });
    // Asked for, but never granted on an image base, so advising on it would
    // describe authority no agent has.
    expect(ignored.safety.map((entry) => entry.code)).not.toContain(
      "SNAPSHOT_UPDATE_AUTHORITY",
    );
  });

  it("never quotes the script that produced a finding", () => {
    const serialized = JSON.stringify(result.safety);
    expect(serialized).not.toContain("EXAMPLE_TOKEN");
    expect(serialized).not.toContain("credential.helper");
    expect(serialized).not.toContain("git push");
    expect(serialized).not.toContain("npm publish");
  });

  it("locates a finding by field and line, not by offset into the document", () => {
    const secret = result.safety.find(
      (finding) => finding.code === "CREDENTIAL_ENV_PERSISTENCE",
    );
    expect(secret?.path).toBe("install");
    expect(secret?.line).toBe(2);
  });

  it("treats strict shell mode as advisory, and only for install and start", () => {
    const advisories = result.safety.filter(
      (finding) => finding.code === "STRICT_SHELL_MODE_ABSENT",
    );
    expect(advisories.map((finding) => finding.severity)).toEqual([
      "advisory",
      "advisory",
    ]);
    expect(advisories.map((finding) => finding.path).sort()).toEqual([
      "install",
      "start",
    ]);

    const strict = validate("observed-sanitized.json");
    expect(
      strict.safety.some((finding) => finding.code === "STRICT_SHELL_MODE_ABSENT"),
    ).toBe(false);
  });

  it("reports a dotfile append and an empty MCP allowlist as advisories only", () => {
    const append = result.safety.find(
      (finding) => finding.code === "NON_IDEMPOTENT_APPEND",
    );
    expect(append?.severity).toBe("advisory");

    const empty = validateDefinition({
      text: '{"mcpServerAllowlist": []}',
      source: "proposed",
      origin: "test",
    });
    const finding = empty.safety.find(
      (item) => item.code === "MCP_ALLOWLIST_EMPTY_INHERITS",
    );
    expect(finding?.severity).toBe("advisory");
  });

  it("warns when a container path climbs out of the repository", () => {
    const escaping = validateDefinition({
      text: '{"build": {"dockerfile": "../../outside/Dockerfile"}}',
      source: "proposed",
      origin: "test",
    });
    expect(
      escaping.safety.some(
        (finding) => finding.code === "PATH_ESCAPES_REPOSITORY_ROOT",
      ),
    ).toBe(true);
  });
});

describe("capability limitations", () => {
  it("always states that nothing here persists a definition", () => {
    const codes = validate("observed-sanitized.json").limitations.map(
      (limitation) => limitation.code,
    );
    expect(codes).toContain("NO_HOST_PERSISTENCE");
  });

  it("labels a saved document read from inside a run as delegated evidence", () => {
    const result = validateDefinition({
      text: fixture("observed-sanitized.json"),
      source: "delegated-saved",
      origin: "delegated run (untrusted evidence)",
    });
    expect(result.trust).toBe("delegated-untrusted");
    expect(result.limitations.map((limitation) => limitation.code)).toContain(
      "DELEGATED_EVIDENCE",
    );
  });

  it("reads a local definition without creating one, and calls absence absence", async () => {
    const root = await mkdtemp(join(tmpdir(), "cursor-mcp-env-"));
    const missing = await readLocalDefinition(root);
    expect(missing.present).toBe(false);
    expect(missing.path.endsWith("/.cursor/environment.json")).toBe(true);

    const absent = absentDefinition({ source: "local-file", origin: missing.path });
    expect(absent.status).toBe("absent");
    expect(absent.errors).toEqual([]);
    expect(absent.limitations.map((limitation) => limitation.code)).toContain(
      "LOCAL_DEFINITION_ABSENT",
    );

    await mkdir(join(root, ".cursor"));
    await writeFile(
      join(root, ".cursor", "environment.json"),
      fixture("valid-commented.jsonc"),
      "utf8",
    );
    const present = await readLocalDefinition(root);
    expect(present.present).toBe(true);
    if (!present.present || "tooLarge" in present) return;
    expect(
      validateDefinition({
        text: present.text,
        source: "local-file",
        origin: present.path,
      }).status,
    ).toBe("valid");
  });

  it("bounds a local file before returning its contents", async () => {
    const root = await mkdtemp(join(tmpdir(), "cursor-mcp-env-large-"));
    await mkdir(join(root, ".cursor"));
    await writeFile(
      join(root, ".cursor", "environment.json"),
      "x".repeat(MAX_DEFINITION_BYTES + 1),
      "utf8",
    );
    const result = await readLocalDefinition(root);
    expect(result).toMatchObject({
      present: true,
      tooLarge: true,
      sizeBytes: MAX_DEFINITION_BYTES + 1,
    });
    expect(result).not.toHaveProperty("text");
  });

  it("refuses a definition symlink that resolves outside the repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "cursor-mcp-env-link-"));
    const outside = await mkdtemp(join(tmpdir(), "cursor-mcp-env-outside-"));
    const target = join(outside, "environment.json");
    await writeFile(target, "{}", "utf8");
    await mkdir(join(root, ".cursor"));
    await symlink(target, join(root, ".cursor", "environment.json"));
    await expect(readLocalDefinition(root)).rejects.toThrow(
      "resolves outside the repository root",
    );
  });
});

describe("semantic diff", () => {
  it("redacts every string field, including labels, and redacts a script", () => {
    const before = definitionOf("observed-sanitized.json");
    const after: EnvironmentDefinition = {
      ...before,
      name: "renamed",
      install: "set -euo pipefail\nnpm ci --omit=dev\n",
    };
    const diff = diffDefinitions(before, after);
    expect(diff.identical).toBe(false);

    const renamed = diff.changes.find((change) => change.path === "name");
    expect(renamed).toMatchObject({
      change: "changed",
      redacted: true,
    });
    expect(renamed?.before).toMatch(/^sha256:[0-9a-f]{12} \(\d+ bytes\)$/);
    expect(renamed?.after).toMatch(/^sha256:[0-9a-f]{12} \(\d+ bytes\)$/);
    expect(JSON.stringify(diff)).not.toContain("renamed");

    const install = diff.changes.find((change) => change.path === "install");
    expect(install?.redacted).toBe(true);
    expect(install?.after).toMatch(/^sha256:[0-9a-f]{12} \(\d+ bytes\)$/);
    expect(JSON.stringify(diff)).not.toContain("omit=dev");
  });

  it("does not echo malformed source text through a parser error", () => {
    const secret = "should-not-leave-the-parser";
    const result = validateDefinition({
      text: `{"install":"${secret}", broken}`,
      source: "proposed",
      origin: "test",
    });
    expect(result.status).toBe("invalid");
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("reports an identical pair as identical", () => {
    const definition = definitionOf("valid-commented.jsonc");
    expect(diffDefinitions(definition, definition)).toEqual({
      identical: true,
      changes: [],
      truncated: false,
    });
  });

  it("descends into an added object rather than emitting one blob", () => {
    const diff = diffDefinitions({}, { build: { dockerfile: "Dockerfile" } });
    expect(diff.changes).toEqual([
      {
        path: "build.dockerfile",
        change: "added",
        after: expect.stringMatching(/^sha256:[0-9a-f]{12} \(\d+ bytes\)$/),
        redacted: true,
      },
    ]);
  });

  it("reports a removed field as removed", () => {
    const diff = diffDefinitions({ snapshot: "snapshot-placeholder" }, {});
    expect(diff.changes).toEqual([
      {
        path: "snapshot",
        change: "removed",
        before: expect.stringMatching(/^sha256:[0-9a-f]{12} \(\d+ bytes\)$/),
        redacted: true,
      },
    ]);
  });

  it("redacts a terminal command and its caller-controlled name", () => {
    const diff = diffDefinitions(
      { terminals: [{ name: "dev", command: "npm run dev" }] },
      { terminals: [{ name: "dev-server", command: "npm run serve" }] },
    );
    const name = diff.changes.find((change) => change.path === "terminals[0].name");
    expect(name?.redacted).toBe(true);
    const command = diff.changes.find(
      (change) => change.path === "terminals[0].command",
    );
    expect(command?.redacted).toBe(true);
    expect(JSON.stringify(diff)).not.toContain("dev-server");
    expect(JSON.stringify(diff)).not.toContain("npm run serve");
  });

  it("caps the change list and says it was capped", () => {
    const ports = (start: number) =>
      Array.from({ length: MAX_DIFF_CHANGES + 20 }, (_unused, index) => ({
        port: start + index,
      }));
    const diff = diffDefinitions({ ports: ports(1000) }, { ports: ports(2000) });
    expect(diff.changes).toHaveLength(MAX_DIFF_CHANGES);
    expect(diff.truncated).toBe(true);
    expect(diff.identical).toBe(false);
  });
});

describe("synchronization request", () => {
  const definition = definitionOf("observed-sanitized.json");

  it("routes a database-managed environment to an owner Save", () => {
    const request = buildSynchronizationRequest({
      environmentPublicId: "env-public",
      definition,
      environmentJsonPath: null,
    });
    expect(request.managedAs).toBe("database");
    expect(request.authority).toBe("browser-session");
    expect(request.ownerAction).toBe("SAVE_ENVIRONMENT");
    expect(request.requiresOwnerSave).toBe(true);
    expect(request.requiresRepositoryCommit).toBe(false);
    expect(request.ready).toBe(true);
    expect(request.persisted).toBe(false);
    expect(request.requiredReadback).toContain("environmentVersionPublicId");
  });

  it("routes a repository-file environment to a commit, not a Save", () => {
    const request = buildSynchronizationRequest({
      environmentPublicId: "env-public",
      definition,
      environmentJsonPath: ".cursor/environment.json",
    });
    expect(request.managedAs).toBe("repository-file");
    expect(request.authority).toBe("repo-commit");
    expect(request.ownerAction).toBeUndefined();
    expect(request.requiresRepositoryCommit).toBe(true);
    expect(request.requiresOwnerSave).toBe(false);
    expect(request.requiredReadback).toContain(".cursor/environment.json");
  });

  it("stops when the managed type is unknown", () => {
    const request = buildSynchronizationRequest({
      environmentPublicId: "env-public",
      definition,
    });
    expect(request.managedAs).toBe("unknown");
    expect(request.ready).toBe(false);
    expect(request.authority).toBeUndefined();
    expect(request.requiredReadback).toContain("environmentJsonPath");
  });

  it("carries digests and no receipt fields", () => {
    const request = buildSynchronizationRequest({
      environmentPublicId: "env-public",
      definition,
      environmentJsonPath: null,
      safety: validate("unsafe-scripts.json").safety,
    });
    // Pinned so "no durable identifier" stays testable offline: a buildId is not
    // a Save receipt, and a version id is discovered by readback, not returned.
    expect(Object.keys(request).sort()).toEqual(
      [
        "authority",
        "definitionDigest",
        "environmentJsonPath",
        "environmentPublicId",
        "installDigest",
        "managedAs",
        "nextSteps",
        "ownerAction",
        "persisted",
        "ready",
        "requiredReadback",
        "requiresOwnerSave",
        "requiresRepositoryCommit",
        "safetyWarningCount",
        "startDigest",
      ].sort(),
    );
    expect(request.definitionDigest).toMatch(/^sha256:[0-9a-f]{12}$/);
    expect(request.installDigest).toMatch(/^sha256:[0-9a-f]{12}$/);
    expect(request.safetyWarningCount).toBeGreaterThan(0);
    expect(JSON.stringify(request)).not.toContain("npm ci");
  });
});
