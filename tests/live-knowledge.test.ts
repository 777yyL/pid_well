import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import {
  migrateProductKnowledge,
  liveKnowledge,
} from "../server/product-knowledge.js";
import type { Database } from "../server/db.js";

test("live PG catalog needs no release and reflects active business rows immediately", async () => {
  const engine = new PGlite();
  const wrap = (client: any): Database => ({
    query: async (sql, params = []) => (await client.query(sql, params)).rows,
    transaction: (fn) => engine.transaction((tx) => fn(wrap(tx))),
    close: () => engine.close(),
  });
  const db = wrap(engine);
  try {
    await db.query("CREATE TABLE users(id uuid PRIMARY KEY)");
    await db.query("CREATE TABLE projects(id uuid PRIMARY KEY)");
    await migrateProductKnowledge(db);
    await db.query(
      "INSERT INTO kb_products(product_id,product_code,name,status) VALUES('p','PS','办案','active'),('retired','old','下架','retired')",
    );
    await db.query(
      "INSERT INTO kb_product_versions(product_version_id,product_id,version,status) VALUES('v','p','v1','active'),('oldv','retired','v1','active')",
    );
    await db.query(
      "INSERT INTO kb_sale_items(sale_item_id,product_version_id,name,specification_md,status) VALUES('s','v','人身检查','记录检查结果','active'),('hidden','oldv','旧功能','不参与','active')",
    );
    const first = await liveKnowledge(db);
    assert.deepEqual(
      first.data.saleItems.map((s) => s.sale_item_id),
      ["s"],
    );
    await db.query(
      "UPDATE kb_sale_items SET specification_md='拍照留痕' WHERE sale_item_id='s'",
    );
    const second = await liveKnowledge(db);
    assert.equal(second.data.saleItems[0].specification_md, "拍照留痕");
    assert.equal((await db.query("SELECT id FROM kb_releases")).length, 0);
  } finally {
    await db.close();
  }
});
