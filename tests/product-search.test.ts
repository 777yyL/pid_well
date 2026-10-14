import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { openDatabase, migrate } from "../server/db.js";
import { WikiClient, snapshotPage, wikiFilePaths } from "../server/wiki.js";
import {
  readCatalogPage,
  searchSelected,
  searchGlobalFallback,
  recordAlternative,
  linkedWikiPaths,
  resolveProductPage,
  validateCatalogSale,
} from "../server/product-search.js";
import {
  enforceProductScope,
  selectProducts,
  productScope,
} from "../server/product-scope.js";
import type { AssessmentInput } from "../shared/domain.js";
import { parseSaleEntity } from "../server/sale-entity.js";
test("Wiki 文件树绝对路径规范化，拒绝越界路径", () => {
  assert.deepEqual(
    wikiFilePaths({
      files: [
        { path: "//?/E:/project/wiki/entities/versions/a-v1.5.100.md" },
        {
          children: [{ path: "C:\\project\\wiki\\entities\\sales\\volume.md" }],
        },
        "wiki/entities/sale-items/item.md",
        "E:/project/wiki/../secret.md",
      ],
    }),
    [
      "wiki/entities/versions/a-v1.5.100.md",
      "wiki/entities/sales/volume.md",
      "wiki/entities/sale-items/item.md",
    ],
  );
});

test("带点裸名双链按文件清单跨目录定位，重名不能猜测", () => {
  const version = "wiki/entities/versions/example-v1.5.100.md";
  assert.deepEqual(
    linkedWikiPaths(
      "[[example-v1.5.100]]",
      "wiki/entities/products/example.md",
      [version],
    ),
    [version],
  );
  assert.throws(
    () =>
      linkedWikiPaths("[[missing]]", "wiki/entities/products/example.md", []),
    /未找到/,
  );
  assert.throws(
    () =>
      linkedWikiPaths("[[same]]", "wiki/entities/products/example.md", [
        "wiki/entities/sales/same.md",
        "wiki/entities/sale-items/same.md",
      ]),
    /重名/,
  );
});

test("Markdown 表头不作为实体版本字段，键值表仍可读取", () => {
  assert.equal(
    parseSaleEntity(
      "# 产品\n| 版本 | 销售项数 | 版本快照 |\n| --- | --- | --- |\n| v1.5.100 | 54 | [[example]] |",
    ).version,
    "",
  );
  assert.equal(
    parseSaleEntity("| 字段 | 值 |\n| --- | --- |\n| 版本 | v1.5.100 |")
      .version,
    "v1.5.100",
  );
});

test("空路径使用产品标识定位，并通过指定版本目录校验销售项", async () => {
  const db = await openDatabase("", "memory://");
  await migrate(db);
  const uid = randomUUID(),
    pid = randomUUID();
  const cid = randomUUID(),
    rid = randomUUID();
  const originalRead = WikiClient.prototype.read;
  const originalFiles = WikiClient.prototype.files;
  try {
    await db.query(
      "INSERT INTO users(id,username,display_name,password_hash,role) VALUES($1,'resolve_test','测试','hash','admin')",
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
    const path = "wiki/entities/products/infovision-ieducation-safety.md";
    const versionPath =
      "wiki/entities/versions/infovision-ieducation-safety-v1.5.100.md";
    const salePath = "wiki/entities/sale-items/safety.md";
    await snapshotPage(
      db,
      pid,
      path,
      "# 校园安全平台\n- 产品标识: Infovision iEducation-Safety\n| 版本 | 销售项数 | 版本快照 |\n| --- | --- | --- |\n| v1.5.100 | 54 | [[infovision-ieducation-safety-v1.5.100]] |",
    );
    await snapshotPage(
      db,
      pid,
      versionPath,
      "---\nversion: v1.5.100\n---\n[[safety-volume]]",
    );
    const volumePath = "wiki/entities/sales/safety-volume.md";
    await snapshotPage(db, pid, volumePath, "# 安全分册\n[[safety]]");
    WikiClient.prototype.files = async () => [
      path,
      versionPath,
      volumePath,
      salePath,
    ];
    const sale = await snapshotPage(
      db,
      pid,
      salePath,
      "---\ntitle: 校园安全\nproduct: Infovision iEducation-Safety\nversion: v1.5.100\nmodule_id: SAFETY\n---",
    );
    const choice = {
      name: "Infovision iEducation-Safety",
      version: "v1.5.100",
      path: "",
    };
    assert.equal((await resolveProductPage(db, pid, choice))?.path, path);
    await selectProducts(db, pid, uid, {
      expectedRevision: 1,
      selected: [choice],
    });
    const scope = await productScope(db, pid);
    assert.equal(scope.selected[0].path, path);
    await validateCatalogSale(db, pid, scope.selected[0], sale, "v1.5.100");
    // Existing confirmed scopes with empty paths also recover without changing user choices.
    await db.query(
      "UPDATE product_scopes SET selected=$2 WHERE project_id=$1",
      [pid, JSON.stringify([choice])],
    );
    await enforceProductScope(db, pid, {
      product: choice.name,
      version: choice.version,
      sales: ["校园安全"],
      evidence: [{ snapshotId: sale.id }],
    } as AssessmentInput);
    WikiClient.prototype.read = async (_wiki, pagePath) => {
      const [page] = await db.query<{ content: string }>(
        "SELECT content FROM snapshots WHERE project_id=$1 AND path=$2",
        [pid, pagePath],
      );
      assert.ok(page, pagePath);
      return page.content;
    };
    const catalog = await readCatalogPage(db, pid, rid, 0, 25);
    assert.equal(catalog.complete, true);
    assert.equal(catalog.items.length, 1);
    assert.equal(catalog.products[0].path, path);
    assert.equal(catalog.products[0].directoryPath, versionPath);
    await assert.rejects(
      validateCatalogSale(
        db,
        pid,
        { ...scope.selected[0], version: "v9" },
        sale,
        "v1.5.100",
      ),
      /版本目录|版本/,
    );
    await snapshotPage(
      db,
      pid,
      "wiki/entities/products/duplicate.md",
      "# 其他标题\n- 产品标识: Infovision iEducation-Safety",
    );
    await assert.rejects(resolveProductPage(db, pid, choice), /多个产品档案/);
  } finally {
    WikiClient.prototype.read = originalRead;
    WikiClient.prototype.files = originalFiles;
    await db.close();
  }
});

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
