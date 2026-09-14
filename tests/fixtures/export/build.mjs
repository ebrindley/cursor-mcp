/**
 * Generate two entirely synthetic run-export replays and expected counts.
 * Payloads, tool mixes and identifiers are invented test inputs, not recordings.
 */

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const SOURCES = {
  bytes: { byName: { run_terminal_cmd: 8, read_file: 4, grep_search: 2, await: 1, get_mcp_tools: 1, file_search: 1, edit_file: 1 } },
  events: { byName: { run_terminal_cmd: 9, read_file: 7, grep_search: 3, await: 3, edit_file: 2, get_mcp_tools: 1, file_search: 1, pr_management: 1, mcp: 1 } },
};

/**
 * A fake credential, seeded so a test can prove it reaches the raw file and never
 * the tool response. Not a real key shape anyone could mistake for one.
 */
const SEEDED_FAKE_SECRET = "FAKE-NOT-A-REAL-CREDENTIAL-eyJhbGciOiJub25lIn0";

class Replay {
  #chunks = [];
  #seq = 0;
  #dispatched = 0;
  #byType = {};
  #toolCallEvents = 0;
  #unparsed = 0;

  /** Ids advance every second event, so consecutive events share one, as observed. */
  #id() {
    const id = `1757000000000-${Math.floor(this.#seq / 2)}`;
    this.#seq += 1;
    return id;
  }

  raw(text) {
    this.#chunks.push(text);
  }

  event(type, payload, { id = true } = {}) {
    const data = typeof payload === "string" ? payload : JSON.stringify(payload);
    this.#chunks.push(`${id ? `id: ${this.#id()}\n` : ""}event: ${type}\ndata: ${data}\n\n`);
    this.#dispatched += 1;
    this.#byType[type] = (this.#byType[type] ?? 0) + 1;
    if (type === "tool_call") {
      this.#toolCallEvents += 1;
      try {
        JSON.parse(data);
      } catch {
        this.#unparsed += 1;
      }
    }
  }

  /** A frame with an `event:` and an `id:` but no `data:`: dispatches nothing. */
  silent(type) {
    this.#chunks.push(`id: ${this.#id()}\nevent: ${type}\n\n`);
  }

  text() {
    return this.#chunks.join("");
  }

  counts() {
    return {
      events: this.#dispatched,
      byType: this.#byType,
      toolCallEvents: this.#toolCallEvents,
      unparsedToolCalls: this.#unparsed,
    };
  }
}

/** Scale a synthetic tool mix without dropping a tool category. */
function scaleNames(byName, target) {
  const total = Object.values(byName).reduce((a, b) => a + b, 0);
  const scaled = Object.fromEntries(
    Object.entries(byName).map(([name, count]) => [
      name,
      Math.max(1, Math.round((count / total) * target)),
    ]),
  );
  // Spend the rounding difference on the most common name in the synthetic mix.
  const [top] = Object.entries(byName).sort((a, b) => b[1] - a[1])[0];
  scaled[top] += target - Object.values(scaled).reduce((a, b) => a + b, 0);
  return scaled;
}

function successFor(name, i) {
  switch (name) {
    case "run_terminal_cmd":
      return {
        command: `npm test -- tests/example-${i}.test.ts`,
        executionTime: 1_200 + i,
        localExecutionTimeMs: 1_190 + i,
        interleavedOutput: `example ${i}: 4 passed\n`,
        stdout: `example ${i}: 4 passed\n`,
        ...(i % 5 === 0 ? { stderr: `example ${i}: 1 warning\n` } : {}),
      };
    case "read_file":
      return {
        path: `src/example-${i}.ts`,
        content: `export const example${i} = ${i};\n`,
        fileSize: 32 + i,
        totalLines: 1,
        readRange: { start: 1, end: 1 },
      };
    case "grep_search":
      return {
        outputMode: "files_with_matches",
        path: "/agent/repos/example",
        pattern: `example-${i}`,
        workspaceResults: {
          "/agent/repos/example": {
            type: "matches",
            output: { matches: [{ file: `src/example-${i}.ts` }], totalMatches: 1 },
          },
        },
      };
    case "edit_file":
      return {
        path: `src/example-${i}.ts`,
        message: "edited",
        diffString: `@@ -1 +1 @@\n-old ${i}\n+new ${i}\n`,
        linesAdded: 1,
        linesRemoved: 1,
      };
    case "file_search":
      return { path: `src/example-${i}.ts`, files: [`src/example-${i}.ts`], totalFiles: 1 };
    case "await":
      return { complete: true };
    case "get_mcp_tools":
      return { content: `example tool ${i}` };
    case "mcp":
      return { content: [{ text: { text: `example mcp result ${i}` } }], isError: false };
    case "pr_management":
      return { content: [{ text: { text: `example pr ${i}` } }] };
    default:
      return { content: `example ${i}` };
  }
}

function argsFor(name, i, secret) {
  switch (name) {
    case "run_terminal_cmd":
      return {
        command: secret
          ? `printf '%s' "$TOKEN" # ${SEEDED_FAKE_SECRET}`
          : `npm test -- tests/example-${i}.test.ts`,
        description: `run example ${i}`,
        timeout: 120,
        timeoutBehavior: "cancel",
        closeStdin: true,
        simpleCommands: ["npm"],
      };
    case "read_file":
      return { path: `src/example-${i}.ts`, offset: 0, headLimit: 200 };
    case "grep_search":
      return { pattern: `example-${i}`, targetDirectory: "/agent/repos/example", multiline: false };
    case "edit_file":
      return { path: `src/example-${i}.ts` };
    case "file_search":
      return { globPattern: `**/example-${i}.ts` };
    case "await":
      return { blockUntilMs: 1_000, taskId: `task-${i}` };
    case "get_mcp_tools":
      return { server: "example", requestId: `req-${i}` };
    case "mcp":
      return { toolName: "example_tool", providerIdentifier: "example", args: { limit: 1 } };
    case "pr_management":
      return { toolName: "create_pr", args: { owner: "ExampleOrg", repo: "ExampleRepo", draft: true } };
    default:
      return { path: `src/example-${i}.ts` };
  }
}

/**
 * Build one replay.
 *
 * `neverCompleted` is the synthetic count of calls left running at stream end.
 */
function build({ source, targetCalls, neverCompleted, seedSecret }) {
  const replay = new Replay();
  const byName = scaleNames(source.byName, targetCalls);
  // Round-robin across the names so calls interleave, as they do in a real run,
  // instead of arriving in one block per tool.
  const queues = Object.entries(byName).map(([name, count]) => ({ name, left: count }));
  const plan = [];
  while (plan.length < targetCalls) {
    for (const queue of queues) {
      if (queue.left === 0) continue;
      queue.left -= 1;
      plan.push(queue.name);
    }
  }

  replay.event("status", { runId: "run-export-1", status: "RUNNING" }, { id: false });
  let secretSeeded = false;
  const runningCalls = [];
  for (const [i, name] of plan.entries()) {
    const callId = `call-${String(i + 1).padStart(4, "0")}`;
    const secret = seedSecret && !secretSeeded && name === "run_terminal_cmd";
    if (secret) secretSeeded = true;
    if (i % 3 === 0) replay.event("thinking", { text: `considering example ${i}` });
    if (i % 4 === 0) replay.event("assistant", { text: `Working on example ${i}.` });
    replay.event("interaction_update", {
      stepId: i,
      callId,
      modelCallId: `model-${i}`,
      text: `example ${i}`,
      tokens: 12 + i,
      stepDurationMs: 40 + i,
      toolCall: { args: argsFor(name, i, secret) },
    });
    if (i === 1) replay.raw(": keepalive\n\n");
    if (i === 2) replay.silent("heartbeat");
    const args = argsFor(name, i, secret);
    for (let r = 0; r <= i % 3; r += 1) {
      replay.event("tool_call", { callId, name, status: "running", args, truncated: false });
    }
    const incomplete = plan.length - i <= neverCompleted;
    if (incomplete) {
      runningCalls.push(callId);
      continue;
    }
    // The result variants are a union, exactly as observed: `success`, `error`,
    // `failure`, or `timeout`, and sometimes no `result` at all on a completion.
    const result =
      i % 17 === 5
        ? { error: { message: `example ${i} failed`, command: `false # ${i}` } }
        : i % 23 === 7
          ? { timeout: { afterMs: 120_000 } }
          : { isBackground: false, success: successFor(name, i) };
    replay.event("tool_call", { callId, name, status: "completed", args, result, truncated: false });
  }
  // A tool-call payload that is not JSON. Retained verbatim in the raw export and
  // counted, never guessed at.
  replay.event("tool_call", "<<not json>>");
  replay.event("status", { runId: "run-export-1", status: "FINISHED" }, { id: false });
  replay.event("result", {
    runId: "run-export-1",
    status: "FINISHED",
    durationMs: 14_400_000,
    text: "Example run finished.",
    git: {
      branches: [
        {
          repoUrl: "https://github.com/ExampleOrg/ExampleRepo",
          branch: "cursor/example-1",
          prUrl: "https://github.com/ExampleOrg/ExampleRepo/pull/1",
        },
      ],
    },
  });
  replay.event("done", {});

  const counts = replay.counts();
  const text = replay.text();
  return {
    text,
    manifest: {
      bytes: Buffer.byteLength(text, "utf8"),
      ...counts,
      calls: plan.length,
      completed: plan.length - neverCompleted,
      running: neverCompleted,
      runningCalls,
      byName,
      // Every distinct `run_terminal_cmd` call, whether or not it completed: a
      // command that never returned is exactly what the log has to show.
      terminalCommands: byName.run_terminal_cmd ?? 0,
      ...(seedSecret ? { seededFakeSecret: SEEDED_FAKE_SECRET } : {}),
    },
  };
}

const fixtures = {
  "synthetic-complete.sse": build({
    source: SOURCES.bytes,
    targetCalls: 18,
    neverCompleted: 0,
    seedSecret: false,
  }),
  "synthetic-incomplete.sse": build({
    source: SOURCES.events,
    targetCalls: 28,
    neverCompleted: 4,
    seedSecret: true,
  }),
};

const manifest = {
  note: "Entirely synthetic payloads and tool mixes. Expected counts are the generator plan, independently checked against parsed exports.",
  builtBy: "tests/fixtures/export/build.mjs",
  fixtures: {},
};
for (const [name, fixture] of Object.entries(fixtures)) {
  writeFileSync(join(here, name), fixture.text, "utf8");
  manifest.fixtures[name] = fixture.manifest;
}
writeFileSync(join(here, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
for (const [name, fixture] of Object.entries(fixtures)) {
  console.log(
    `${name}: ${fixture.manifest.bytes} bytes, ${fixture.manifest.events} events, ` +
      `${fixture.manifest.calls} calls (${fixture.manifest.running} still running)`,
  );
}
