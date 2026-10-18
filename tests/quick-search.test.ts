import { test } from "node:test";
import assert from "node:assert/strict";
import { quickSearchResults } from "../server/quick-search.js";

test("快速检索直接利用响应正文，兼容公司和本地目录，保持返回顺序并去重", () => {
  assert.throws(() => quickSearchResults({ ok: true }), /缺少 results/);
  const response = {
    results: [
      {
        path: "//?/D:/company/wiki/entities/sale-items/visitor.md",
        content:
          "---\ntitle: 访客管理\nproduct: Demo\nversion: v1\nmodule_id: VISITOR\n---\n## 销售项描述\n支持微信预约",
      },
      {
        path: "wiki/entities/old-visitor.md",
        title: "旧版访客",
        content:
          "---\nmodule_id: OLD\n---\n# 旧版访客\n| 所属产品 | [[old-product]] |",
        snippet: "支持访客登记",
      },
      { path: "wiki/entities/sale-items/visitor.md", title: "重复结果" },
      { path: "wiki/entities/products/demo.md", content: "# 产品" },
      { path: "wiki/entities/ordinary.md", content: "# 普通页面" },
      {
        path: "wiki/entities/sale-items/no-content.md",
        title: "无全文销售项",
        snippet: "摘要",
      },
    ],
  };
  const result = quickSearchResults(response);
  assert.deepEqual(
    result.map((r) => r.title),
    ["访客管理", "旧版访客", "无全文销售项"],
  );
  assert.equal(result[0].product, "Demo");
  assert.equal(result[0].summary, "支持微信预约");
  assert.equal(result[1].product, "old-product");
  assert.equal(result[2].summary, "摘要");
});
