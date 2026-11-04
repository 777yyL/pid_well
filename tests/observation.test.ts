import { test } from "node:test";
import assert from "node:assert/strict";
import { redactObservation } from "../server/observation.js";
import { AgentRunner } from "../server/agent.js";
import type { Database } from "../server/db.js";

test("观测递归脱敏且保留业务内容与 token 用量", () => {
  const input = {
    apiKey: "private",
    nested: [{ password: "password", authorization: "secret" }],
    usage: { input: 100, output: 20 },
    text: "Bearer credential sk-abcdefghijklmnop",
    quote: "跨控制器反潜回",
  };
  const output = redactObservation(input) as typeof input;
  assert.equal(output.apiKey, "[REDACTED]");
  assert.equal(output.nested[0].password, "[REDACTED]");
  assert.equal(output.nested[0].authorization, "[REDACTED]");
  assert.equal(output.text, "Bearer [REDACTED] [REDACTED]");
  assert.deepEqual(output.usage, input.usage);
  assert.equal(output.quote, input.quote);
  assert.equal(input.apiKey, "private");
});

test("执行事件写库前即脱敏，避免凭据进入持久化记录", async () => {
  let values: unknown[] = [];
  const db = {
    query: async (_sql: string, args: unknown[]) => {
      values = args;
      return [];
    },
  } as unknown as Database;
  await new AgentRunner(db).emit("run-id", "tool_execution_start", {
    args: { api_key: "secret", query: "访客管理" },
  });
  assert.deepEqual(JSON.parse(String(values[2])), {
    args: { api_key: "[REDACTED]", query: "访客管理" },
  });
});
