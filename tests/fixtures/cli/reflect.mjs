// A fake Cursor CLI that reports its own execution context.
//
// Used to prove what the child does and does not receive: the environment it was
// given, the argument vector verbatim, and the working directory. If a shell were
// involved, `$HOME` and `;` in an argument would not survive as literal text.

const args = process.argv.slice(2);

if (args.join(" ") === "--version") {
  process.stdout.write("cursor 1.2.3\n");
  process.exit(0);
}

process.stdout.write(
  JSON.stringify({
    envKeys: Object.keys(process.env).sort(),
    argv: args,
    cwd: process.cwd(),
  }) + "\n",
);
process.exit(0);
