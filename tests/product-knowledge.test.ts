import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import Fastify from "fastify";
import { createHash, randomUUID } from "node:crypto";
import type { Database } from "../server/db.js";
import {
  migrateProductKnowledge,
  knowledgeRoutes,
  getProjectKnowledge,
  bindProjectKnowledge,
  latestKnowledge,
} from "../server/product-knowledge.js";

test("knowledge publishes immutable snapshots, scopes access, browses pages and rejects incomplete drafts", async () => {
  const engine = new PGlite();
  await engine.waitReady;
  const wrap = (client: any): Database => ({
    query: async (sql, params = []) => (await client.query(sql, params)).rows,
    transaction: (fn) => engine.transaction((tx) => fn(wrap(tx))),
    close: () => engine.close(),
  });
  const db = wrap(engine);
  await db.query("CREATE TABLE users(id uuid PRIMARY KEY)");
  await db.query(
    "CREATE TABLE projects(id uuid PRIMARY KEY,wiki_project_id text,owner_id uuid)",
  );
  await db.query("CREATE TABLE project_members(project_id uuid,user_id uuid)");
  const admin = randomUUID(),
    member = randomUUID(),
    project = randomUUID();
  await db.query("INSERT INTO users VALUES($1),($2)", [admin, member]);
  await db.query("INSERT INTO projects VALUES($1,'space',$2)", [
    project,
    admin,
  ]);
  await migrateProductKnowledge(db);
  await migrateProductKnowledge(db);
  await db.query(
    "INSERT INTO product_kb.kb_products(product_id,product_code,name,status,source_path) VALUES('p','code','产品','active','wiki/entities/products/p.md')",
  );
  await db.query(
    "INSERT INTO product_kb.kb_product_versions(product_version_id,product_id,version,status) VALUES('v','p','v1','active')",
  );
  await db.query(
    "INSERT INTO product_kb.kb_categories(category_id,product_version_id,name) VALUES('c','v','分类')",
  );
  await db.query(
    "INSERT INTO product_kb.kb_sale_items(sale_item_id,product_version_id,category_id,module_code,name,specification_md,status) VALUES('s','v','c','M1','模块一','原文','active'),('s2','v',NULL,'M2','模块二','完整原文','active')",
  );
  const app = Fastify();
  app.decorateRequest("user", null);
  app.addHook("onRequest", async (request) => {
    if (request.headers.authorization === "admin")
      request.user = {
        id: admin,
        role: "admin",
        username: "admin",
        display_name: "admin",
      };
    if (request.headers.authorization === "member")
      request.user = {
        id: member,
        role: "member",
        username: "member",
        display_name: "member",
      };
  });
  knowledgeRoutes(app, db);
  const publish = () =>
    app.inject({
      method: "POST",
      url: "/api/knowledge/releases",
      headers: { authorization: "admin" },
      payload: { wikiProjectId: "space", name: "发布" },
    });
  assert.equal(
    (await app.inject("/api/knowledge/releases?wikiProjectId=space"))
      .statusCode,
    401,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/knowledge/releases",
        headers: { authorization: "member" },
        payload: { wikiProjectId: "space", name: "x" },
      })
    ).statusCode,
    403,
  );
  const response = await publish();
  assert.equal(response.statusCode, 201, response.body);
  const release = response.json().release;
  assert.equal(await getProjectKnowledge(db, project), null);
  await db.transaction((tx) => bindProjectKnowledge(tx, project, release.id));
  const catalog = await app.inject({
    url: `/api/projects/${project}/knowledge/catalog?name=code&version=v1&limit=1`,
    headers: { authorization: "admin" },
  });
  assert.equal(catalog.statusCode, 200, catalog.body);
  const browse = catalog.json();
  assert.equal(browse.total, 2);
  const renderedPath = `wiki/structured/${release.id}/products/${createHash("sha256").update("p").digest("hex")}.md`;
  for (const productId of ["p", "code"])
    for (const path of ["wiki/entities/products/p.md", renderedPath]) {
      const scoped = await app.inject({
        url: `/api/projects/${project}/knowledge/catalog?name=code&version=v1&productId=${productId}&path=${encodeURIComponent(path)}`,
        headers: { authorization: "admin" },
      });
      assert.equal(scoped.statusCode, 200, scoped.body);
      assert.equal(scoped.json().product.product_id, "p");
      assert.equal(scoped.json().total, 2);
    }
  const mismatch = await app.inject({
    url: `/api/projects/${project}/knowledge/catalog?name=wrong&version=v1&productId=code`,
    headers: { authorization: "admin" },
  });
  assert.equal(mismatch.json().total, 0);
  assert.equal(browse.items.length, 1);
  assert.equal(browse.categories.length, 2);
  assert.equal("specification_md" in browse.items[0], false);
  assert.equal(
    (
      await app.inject({
        url: `/api/projects/${project}/knowledge/catalog?name=code&version=v1`,
        headers: { authorization: "member" },
      })
    ).statusCode,
    404,
  );
  await db.query(
    "UPDATE product_kb.kb_sale_items SET specification_md='修改' WHERE sale_item_id='s'",
  );
  assert.equal(
    (await latestKnowledge(db, "space"))?.data.saleItems[0].specification_md,
    "原文",
  );
  const second = (await publish()).json().release;
  await assert.rejects(
    () => db.transaction((tx) => bindProjectKnowledge(tx, project, second.id)),
    /已绑定/,
  );
  assert.equal(
    (
      await app.inject({
        url: `/api/projects/${project}/knowledge/items/s?releaseId=${second.id}`,
        headers: { authorization: "admin" },
      })
    ).statusCode,
    403,
  );
  await db.query(
    "UPDATE product_kb.kb_sale_items SET specification_md=NULL WHERE sale_item_id='s'",
  );
  const invalid = await publish();
  assert.equal(invalid.statusCode, 422);
  assert.match(invalid.json().issues.join(","), /完整技术规格/);
  await db.query(
    "UPDATE product_kb.kb_sale_items SET specification_md='恢复' WHERE sale_item_id='s'",
  );
  await db.query(
    "INSERT INTO product_kb.kb_sale_dependencies(dependency_id,sale_item_id,depends_on_sale_item_id,dependency_type,source_note) VALUES('d1','s','s2','required','原始依赖'),('d2','s2','s','required','原始依赖')",
  );
  const cyclic = await publish();
  assert.equal(cyclic.statusCode, 422);
  assert.match(cyclic.json().issues.join(","), /环路/);
  await db.query("DELETE FROM product_kb.kb_sale_dependencies");
  await db.query(
    "UPDATE product_kb.kb_sale_items SET status='draft' WHERE sale_item_id='s2'",
  );
  await db.query(
    "INSERT INTO product_kb.kb_sale_dependencies(dependency_id,sale_item_id,depends_on_sale_item_id,dependency_type,source_note) VALUES('d3','s','s2','required','原始依赖')",
  );
  const missing = await publish();
  assert.equal(missing.statusCode, 422);
  assert.match(missing.json().issues.join(","), /未启用/);
  await app.close();
  await db.close();
});
