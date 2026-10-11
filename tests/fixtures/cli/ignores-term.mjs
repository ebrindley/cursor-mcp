// Deadline settlement must not wait for close; containment still escalates.
import { spawn } from "node:child_process";

// A separately grouped descendant holds the inherited pipes briefly after the
// direct child is killed. The observer must release its own stream handles.
spawn(process.execPath, ["-e", "setTimeout(() => {}, 8000)"], {
  detached: true, stdio: ["ignore", "inherit", "inherit"],
}).unref();
process.stdout.write("partial output\n");
process.on("SIGTERM", () => {});
setInterval(() => {}, 1_000);
