import { writeFileSync } from "node:fs";

process.on("SIGTERM", () => {
  writeFileSync("term", "termination requested");
  process.exit(0);
});
process.stdout.write("accepted write\n", () => writeFileSync("started", "accepted"));
setInterval(() => {}, 1_000);
