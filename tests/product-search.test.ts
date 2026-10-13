import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { openDatabase, migrate } from "../server/db.js";
import { WikiClient, snapshotPage } from "../server/wiki.js";
import {
  readCatalogPage,
  searchSelected,
  searchGlobalFallback,
  recordAlternative,
  linkedWikiPaths,
} from "../server/product-search.js";
import {
  enforceProductScope,
  selectProducts,
  productScope,
} from "../server/product-scope.js";
import type { AssessmentInput } from "../shared/domain.js";

test("产品目录路径：相对链接、wiki 链接、锚点和越界", () => {
  assert.deepEqual(
    linkedWikiPaths(
      "[门禁](../sale-items/acs.md#规格) [[wiki/entities/sale-items/video|视频]] [外链](https://example.com) [越界](../../../evil.md)",
      "wiki/entities/products/a.md",
    ),
    ["wiki/entities/sale-items/video.md", "wiki/entities/sale-items/acs.md"],
  );
});

test("产品优先检索、全局补查、范围外建议与用户追加范围", async () => {
  const db = await openDatabase("", "memory://");
  await migrate(db);
  const uid = randomUUID(),
    pid = randomUUID(),
    cid = randomUUID(),
    rid = randomUUID();
  const a = {
    name: "产品A",
    version: "v1",
    path: "wiki/entities/products/a.md",
  };
  const b = {
    name: "产品B",
    version: "v2",
    path: "wiki/entities/products/b.md",
  };
  const pageA = "wiki/entities/sale-items/a.md",
    pageB = "wiki/entities/sale-items/b.md";
  const pages: Record<string, string> = {
    [a.path]:
      "---\ntype: product\ntitle: 产品A\nversion: v1\n---\n[销售目录](../sale-items/a.md)",
    [b.path]:
      "---\ntype: product\ntitle: 产品B\nversion: v2\n---\n[销售目录](../sale-items/b.md)",
    [pageA]:
      "---\ntype: sale-item\ntitle: 门禁管理\nproduct: 产品A\nversion: v1\nmodule_id: ACS\n---\n支持门禁认证",
    [pageB]:
      "---\ntype: sale-item\ntitle: 视频管理\nproduct: 产品B\nversion: v2\nmodule_id: VMS\n---\n支持视频联动",
  };
  const originalRead = WikiClient.prototype.read,
    originalSearch = WikiClient.prototype.search;
  let globalCalls = 0;
  WikiClient.prototype.read = async (_id, path) => {
    assert.ok(pages[path], path);
    return pages[path];
  };
  WikiClient.prototype.search = async () => {
    globalCalls++;
    return { results: [{ path: pageB }] };
  };
  try {
    await db.query(
      "INSERT INTO users(id,username,display_name,password_hash,role) VALUES($1,'scope_test','测试','hash','admin')",
      [uid],
    );
    await db.query(
      "INSERT INTO projects(id,name,wiki_project_id,owner_id) VALUES($1,'测试','wiki',$2)",
      [pid, uid],
    );
    await db.query(
      "INSERT INTO conversations(id,project_id,title) VALUES($1,$2,'测试')",
      [cid, pid],
    );
    await db.query(
      "INSERT INTO runs(id,conversation_id,project_id,user_id,input,idempotency_key,status) VALUES($1,$2,$3,$4,'测试',$5,'completed')",
      [rid, cid, pid, uid, randomUUID()],
    );
    await db.query(
      "INSERT INTO requirements(id,project_id,data,confirmed) VALUES('T-1',$1,'{}',true),('T-2',$1,'{}',true)",
      [pid],
    );
    await selectProducts(db, pid, uid, {
      expectedRevision: 1,
      selected: [a],
      strategy: "",
    });
    const fallback = {
      requirementId: "T-1",
      query: "视频",
      topK: 5,
      reason: "no_match" as const,
      explanation: "当前产品目录中未找到视频联动的销售项",
    };
    await assert.rejects(
      searchGlobalFallback(db, pid, rid, fallback),
      /尚未完成产品内/,
    );
    await assert.rejects(
      searchSelected(db, pid, rid, "T-1", "视频", 5),
      /完整销售项目录/,
    );
    assert.equal(globalCalls, 0);
    const catalog = await readCatalogPage(db, pid, rid, 0, 25);
    assert.equal(catalog.complete, true);
    assert.equal(catalog.items[0].title, "门禁管理");
    const result = await searchSelected(db, pid, rid, "T-1", "视频", 5);
    assert.equal(result.total, 0);
    assert.equal(globalCalls, 0);
    await searchGlobalFallback(db, pid, rid, fallback);
    assert.equal(globalCalls, 1);
    await searchSelected(db, pid, rid, "T-2", "门禁", 5);
    await assert.rejects(
      searchGlobalFallback(db, pid, rid, { ...fallback, requirementId: "T-2" }),
      /已有候选/,
    );
    await searchGlobalFallback(db, pid, rid, {
      ...fallback,
      requirementId: "T-2",
      reason: "insufficient_evidence",
      explanation: "目录中的门禁认证没有证明视频联动能力",
    });
    await snapshotPage(db, pid, b.path, pages[b.path]);
    const sale = await snapshotPage(db, pid, pageB, pages[pageB]);
    const suggestion = {
      requirementId: "T-1",
      product: b,
      sales: "视频管理",
      reason: "产品B的视频管理实体明确提供视频联动能力",
      evidence: {
        snapshotId: sale.id,
        lineStart: 8,
        lineEnd: 8,
        quote: "支持视频联动",
      },
    };
    await recordAlternative(db, pid, rid, suggestion);
    const item = {
      product: b.name,
      version: b.version,
      sales: ["视频管理"],
      evidence: [suggestion.evidence],
    } as AssessmentInput;
    await assert.rejects(enforceProductScope(db, pid, item), /确认范围/);
    const scope = await productScope(db, pid);
    // Existing assessments allow append only, preserving every original product and version.
    await db.query(
      "INSERT INTO assessments(id,project_id,requirement_id,data,source) VALUES($1,$2,'T-1','{}','agent')",
      [randomUUID(), pid],
    );
    await assert.rejects(
      selectProducts(db, pid, uid, {
        expectedRevision: scope.revision,
        selected: [b],
      }),
      /不能移除/,
    );
    await selectProducts(db, pid, uid, {
      expectedRevision: scope.revision,
      selected: [a, b],
    });
    await enforceProductScope(db, pid, item);
    await assert.rejects(
      enforceProductScope(db, pid, {
        ...item,
        product: a.name,
        version: a.version,
      }),
      /所属产品/,
    );
    await assert.rejects(
      searchGlobalFallback(db, pid, rid, fallback),
      /尚未完成产品内/,
    );
    const wrong = await snapshotPage(
      db,
      pid,
      pageB,
      pages[pageB].replace("version: v2", "version: v99"),
    );
    await assert.rejects(
      enforceProductScope(db, pid, {
        ...item,
        evidence: [{ ...suggestion.evidence, snapshotId: wrong.id }],
      }),
      /版本/,
    );
    const trace = await db.query<{ action: string }>(
      "SELECT action FROM audit_log WHERE project_id=$1 AND action IN ('product_scoped_search','product_global_search','product_alternative') ORDER BY id",
      [pid],
    );
    assert.deepEqual(
      trace.map((r) => r.action),
      [
        "product_scoped_search",
        "product_global_search",
        "product_scoped_search",
        "product_global_search",
        "product_alternative",
      ],
    );
  } finally {
    WikiClient.prototype.read = originalRead;
    WikiClient.prototype.search = originalSearch;
    await db.close();
  }
});
