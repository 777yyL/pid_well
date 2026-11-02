import { test } from "node:test";
import assert from "node:assert/strict";
import {
  catalogPackets,
  selectCatalogPackets,
  type CatalogContext,
} from "../server/catalog-context.js";
import type { RequirementInput } from "../shared/domain.js";
const requirement = { id: "T-1" } as RequirementInput;
const context = {
  scopeRevision: 2,
  index: [{ id: "S-1" }, { id: "S-2" }],
  candidates: [
    { path: "ps", excerpts: [{ quote: "完整规格，末尾限制也必须保留" }] },
    { path: "other" },
  ],
} as CatalogContext;
test("模型按目录ID选候选，程序保留全文和来源身份", () => {
  const [packet] = catalogPackets(context, [requirement], {
    selections: [{ requirementId: "T-1", catalogIds: ["S-1", "S-1"] }],
  });
  assert.equal(packet.candidates.length, 1);
  assert.equal(packet.candidates[0], context.candidates[0]);
});
test("目录超过上下文预算时遍历所有分片，候选不限制前三项", async () => {
  const catalog = {
    ...context,
    index: Array.from({ length: 8 }, (_, i) => ({
      id: `S-${i + 1}`,
      capabilities: "能力".repeat(120),
    })),
    candidates: Array.from({ length: 8 }, (_, i) => ({ path: `p${i}` })),
  } as CatalogContext;
  const seen: string[] = [];
  const [packet] = await selectCatalogPackets(
    catalog,
    [requirement],
    async (requirements, shard) => {
      seen.push(...shard.map((s) => s.id));
      return {
        selections: requirements.map((r) => ({
          requirementId: r.id,
          catalogIds: shard.map((s) => s.id),
        })),
      };
    },
    new AbortController().signal,
    2900,
  );
  assert.deepEqual(
    seen,
    catalog.index.map((s) => s.id),
  );
  assert.equal(packet.candidates.length, 8);
});
test("目录选择拒绝范围外ID、漏项和错条款，允许确实无候选", () => {
  for (const selections of [
    [],
    [{ requirementId: "T-2", catalogIds: [] }],
    [{ requirementId: "T-1", catalogIds: ["fake"] }],
  ])
    assert.throws(() => catalogPackets(context, [requirement], { selections }));
  assert.equal(
    catalogPackets(context, [requirement], {
      selections: [{ requirementId: "T-1", catalogIds: [] }],
    })[0].candidates.length,
    0,
  );
});
