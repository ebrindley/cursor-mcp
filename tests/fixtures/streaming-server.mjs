// Subprocess fixture: exercise real main()/stdio shutdown without network.
globalThis.fetch = async (input) => {
  const path = new URL(String(input)).pathname;
  if (path.endsWith("/stream")) {
    process.stderr.write("fixture-stream-open\n");
    return new Response(new ReadableStream(), { headers: { "content-type": "text/event-stream" } });
  }
  if (path === "/v1/agents/bc-1") return new Response(JSON.stringify({
    id: "bc-1", status: "IDLE", url: "https://cursor.com/agents/bc-1",
    createdAt: "t", updatedAt: "t", repos: [{ url: "https://github.com/O/R" }],
  }));
  throw new Error("Unexpected fixture request");
};
const { main } = await import("../../src/server.ts");
await main();
