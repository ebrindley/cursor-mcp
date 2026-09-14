// A fake Cursor CLI that hangs, and leaves a descendant behind while it does.
//
// The grandchild would write `descendant.log` into the working directory after a
// delay. It is spawned without `detached`, so it shares the process group and the
// runner's group kill must reap it: nothing may outlive the timeout.

import { spawn } from "node:child_process";
import { join } from "node:path";

const args = process.argv.slice(2);
const line = args.join(" ");

if (line === "--version") {
  process.stdout.write("cursor 1.2.3\n");
  process.exit(0);
}

const marker = join(process.cwd(), "descendant.log");
spawn(
  process.execPath,
  [
    "-e",
    `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "survived"), 1500)`,
  ],
  { stdio: "ignore" },
);

setTimeout(() => process.exit(0), 60_000);
