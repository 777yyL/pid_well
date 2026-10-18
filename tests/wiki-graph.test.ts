import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeWikiGraph } from "../server/wiki-graph.js";

test("Wiki图谱保留真实边，去重并排除指向缺失节点的边，不推断依赖", () => {
  const graph = normalizeWikiGraph(
    {
      nodes: [
        {
          id: "a",
          label: "销售项",
          path: "//?/D:/company/wiki/entities/sale-items/a.md",
          nodeType: "entity",
        },
        {
          id: "b",
          label: "产品",
          path: "wiki/entities/products/b.md",
          nodeType: "entity",
        },
        { id: "a", label: "重复" },
      ],
      edges: [
        { source: "a", target: "b" },
        { source: "b", target: "a" },
        { source: "a", target: "missing" },
        { source: "a", target: "a" },
      ],
    },
    60,
  );
  assert.equal(graph.nodes.length, 2);
  assert.equal(graph.nodes[0].path, "wiki/entities/sale-items/a.md");
  assert.deepEqual(graph.edges, [
    { source: "a", target: "b", label: "双链关联" },
  ]);
  assert.throws(
    () => normalizeWikiGraph({ nodes: [] }, 60),
    /缺少 nodes 或 edges/,
  );
  assert.equal(
    normalizeWikiGraph({ nodes: [{ id: "a" }], edges: [] }, 1).truncated,
    true,
  );
});
