import { test } from "node:test";
import assert from "node:assert/strict";
import { createTools } from "../server/tools.js";
import { WikiClient, PRODUCT_OVERVIEW_PATH } from "../server/wiki.js";
import type { Database } from "../server/db.js";

test("产品总览工具固定路径，不接受模型覆盖，并生成总览证据", async () => {
  let requested = "",
    kind: unknown;
  const original = WikiClient.prototype.read;
  WikiClient.prototype.read = async (_project, path) => {
    requested = path;
    return "# 产品总览\n综合平台与门禁平台";
  };
  const db: Database = {
    query: async <T>(sql: string, params: unknown[] = []) => {
      if (sql.startsWith("SELECT wiki_project_id"))
        return [{ wiki_project_id: "bound-wiki" }] as T[];
      if (sql.includes("INSERT INTO snapshots")) {
        kind = params[5];
        return [{ id: "snapshot", hash: params[4] }] as T[];
      }
      return [];
    },
    transaction: async (fn) => fn(db),
    close: async () => {},
  };
  try {
    const tools = createTools({
      db,
      projectId: "project",
      conversationId: "conversation",
      runId: "run",
      userId: "user",
      emit: async () => {},
    });
    const overview = tools.find((t) => t.name === "wiki_overview")!;
    const response = await overview.execute("test", {
      path: "wiki/incorrect-overview.md",
      start: 2,
      count: 1,
    });
    assert.equal(requested, PRODUCT_OVERVIEW_PATH);
    assert.equal(kind, "overview");
    const text = response.content.find((c) => c.type === "text");
    assert.ok(text && text.type === "text");
    const result = JSON.parse(text.text);
    assert.equal(result.path, "wiki/overview.md");
    assert.equal(result.total, 2);
    assert.match(result.text, /L2/);
    assert.doesNotMatch(result.text, /# 产品总览/);
  } finally {
    WikiClient.prototype.read = original;
  }
});
