import { test } from "node:test";
import assert from "node:assert/strict";
import { capabilityGraph } from "../server/capability-graph.js";

test("关联图谱按原文字段区分产品、依赖和普通关联，保留条件原句", () => {
  const root = "wiki/entities/visitor.md";
  const files = [
    root,
    "wiki/entities/product.md",
    "wiki/entities/base.md",
    "wiki/entities/acs.md",
    "wiki/entities/other.md",
  ];
  const result = capabilityGraph(
    {
      id: "snapshot",
      path: root,
      content: `---
title: 访客管理
related: ["[[product]]", "[[other]]"]
---
| 所属产品 | [[product]] |
| 依赖销售项 | [[base]]（开门联动需 [[acs]]） |
普通关联 [[other]]
\`\`\`
[[fake]]
\`\`\`
`,
    },
    files,
  );
  assert.equal(result.nodes.length, 4);
  assert.equal(
    result.nodes.find((n) => n.path?.endsWith("product.md"))?.relation,
    "product",
  );
  const dep = result.nodes.find((n) => n.path?.endsWith("acs.md"));
  assert.equal(dep?.relation, "dependency");
  assert.match(dep!.quote, /开门联动需/);
  assert.equal(dep?.line, 6);
  assert.equal(
    result.nodes.find((n) => n.path?.endsWith("other.md"))?.relation,
    "related",
  );
});

test("只接受图谱直接邻居，图谱边不升级为依赖，重名链接不可猜测", () => {
  const root = "wiki/entities/sale-items/visitor.md";
  const files = [
    root,
    "wiki/entities/products/demo.md",
    "wiki/entities/sale-items/demo.md",
    "wiki/concepts/related.md",
    "wiki/concepts/unrelated.md",
  ];
  const result = capabilityGraph(
    {
      id: "s",
      path: root,
      content: "# 访客\n[[demo]]\n[危险](../../../../outside.md)",
    },
    files,
    {
      nodes: [
        { id: "root", path: root },
        { id: "n", path: "wiki/concepts/related.md" },
        { id: "u", path: "wiki/concepts/unrelated.md" },
      ],
      edges: [
        { source: "root", target: "n", type: "depends_on" },
        { source: "n", target: "u" },
      ],
    },
  );
  assert.equal(result.nodes.find((n) => n.label === "demo")?.path, undefined);
  assert.match(
    result.nodes.find((n) => n.label === "demo")!.unresolved!,
    /重名/,
  );
  assert.equal(
    result.nodes.find((n) => n.path === "wiki/concepts/related.md")?.relation,
    "related",
  );
  assert.equal(
    result.nodes.some((n) => n.path === "wiki/concepts/unrelated.md"),
    false,
  );
  assert.equal(
    result.nodes.some((n) => n.path?.includes("outside")),
    false,
  );
});
