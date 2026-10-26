import { test } from "node:test";
import assert from "node:assert/strict";
import { WikiClient } from "../server/wiki.js";
import type { Database } from "../server/db.js";
test("scoped search requires server acknowledgement and rejects escaped scope", async () => {
  const client = new WikiClient({} as Database);
  let body: unknown;
  let response: Record<string, unknown> = { results: [] };
  client.request = async (_path, input) => {
    body = input;
    return response;
  };
  await assert.rejects(client.search("p", "q", 5, false, []), /scopeApplied/);
  response = { scopeApplied: true, results: [] };
  await client.search("p", "q", 5, false, []);
  assert.deepEqual(body, {
    query: "q",
    topK: 5,
    includeContent: false,
    allowedPaths: [],
  });
  response = { scopeApplied: true, results: [{ path: "wiki/other.md" }] };
  await assert.rejects(
    client.search("p", "q", 5, false, ["wiki/allowed.md"]),
    /范围外/,
  );
  response = { results: [] };
  await client.search("p", "q");
  assert.equal(Object.hasOwn(body as object, "allowedPaths"), false);
});
