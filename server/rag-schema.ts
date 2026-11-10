import type { Database } from "./db.js";

export async function vectorAvailable(db: Database) {
  const [row] = await db.query<{ available: boolean }>(
    "SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname='vector') AND to_regclass('public.kb_search_vectors') IS NOT NULL AS available",
  );
  return Boolean(row?.available);
}

export async function migrateRagIndex(db: Database) {
  // Extension installation is independent of the business-schema transaction: installations
  // without the server package/privilege keep keyword search and an explicit diagnostic.
  const [extension] = await db.query<{ installed_version: string | null }>(
    "SELECT installed_version FROM pg_available_extensions WHERE name='vector'",
  );
  if (extension && !extension.installed_version) {
    try {
      await db.query("CREATE EXTENSION IF NOT EXISTS vector");
    } catch {
      console.warn(
        "pgvector 未启用：请由数据库管理员安装 vector 扩展；关键词检索仍可使用",
      );
    }
  }
  await db.transaction(async (tx) => {
    await tx.query(
      "CREATE TABLE IF NOT EXISTS rerank_settings(id integer PRIMARY KEY CHECK(id=1),value jsonb NOT NULL)",
    );
    await tx.query(`CREATE TABLE IF NOT EXISTS kb_search_documents(
      sale_item_id text PRIMARY KEY REFERENCES kb_sale_items(sale_item_id) ON DELETE CASCADE,
      product_id text NOT NULL,product_version_id text NOT NULL,category_id text,
      title text NOT NULL,path text NOT NULL,search_text text NOT NULL,evidence_md text NOT NULL,payload jsonb NOT NULL,
      search_vector tsvector NOT NULL,source_hash text NOT NULL,updated_at timestamptz NOT NULL DEFAULT now())`);
    await tx.query(
      "CREATE INDEX IF NOT EXISTS kb_search_documents_fts ON kb_search_documents USING gin(search_vector)",
    );
    await tx.query(
      "CREATE INDEX IF NOT EXISTS kb_search_documents_scope ON kb_search_documents(product_version_id,category_id)",
    );
    for (const sql of [
      "ALTER TABLE kb_index_state ADD COLUMN IF NOT EXISTS generation integer NOT NULL DEFAULT 0",
      "ALTER TABLE kb_index_state ADD COLUMN IF NOT EXISTS dirty boolean NOT NULL DEFAULT true",
      "ALTER TABLE kb_index_state ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0",
      "ALTER TABLE kb_index_state ADD COLUMN IF NOT EXISTS next_retry_at timestamptz NOT NULL DEFAULT now()",
      "ALTER TABLE kb_index_state ADD COLUMN IF NOT EXISTS namespace text NOT NULL DEFAULT ''",
    ])
      await tx.query(sql);
    await tx.query(
      "CREATE INDEX IF NOT EXISTS kb_index_queue_due ON kb_index_state(next_retry_at) WHERE status IN ('pending','failed','indexing')",
    );
    await tx.query('CREATE INDEX IF NOT EXISTS kb_index_dirty ON kb_index_state(sale_item_id) WHERE dirty=true');
    const [done] = await tx.query(
      "SELECT 1 FROM schema_migrations WHERE version=7",
    );
    if (done) return;
    const enqueue = (
      selection: string,
    ) => `INSERT INTO kb_index_state(sale_item_id,status,dirty,generation,attempts,next_retry_at)
      ${selection} ON CONFLICT(sale_item_id) DO UPDATE SET status='pending',dirty=true,
      generation=kb_index_state.generation+1,attempts=0,next_retry_at=now(),error=NULL,updated_at=now();`;
    const triggers = [
      [
        "kb_sale_items",
        "IF TG_OP <> 'DELETE' THEN " +
          enqueue("SELECT NEW.sale_item_id,'pending',true,1,0,now()") +
          " END IF;",
      ],
      [
        "kb_products",
        enqueue(
          "SELECT s.sale_item_id,'pending',true,1,0,now() FROM kb_sale_items s JOIN kb_product_versions v ON v.product_version_id=s.product_version_id WHERE v.product_id=COALESCE(NEW.product_id,OLD.product_id)",
        ),
      ],
      [
        "kb_product_versions",
        enqueue(
          "SELECT s.sale_item_id,'pending',true,1,0,now() FROM kb_sale_items s WHERE s.product_version_id=COALESCE(NEW.product_version_id,OLD.product_version_id)",
        ),
      ],
      [
        "kb_categories",
        enqueue(
          "SELECT s.sale_item_id,'pending',true,1,0,now() FROM kb_sale_items s WHERE s.category_id=COALESCE(NEW.category_id,OLD.category_id)",
        ),
      ],
      [
        "kb_sale_dependencies",
        enqueue(
          "SELECT s.sale_item_id,'pending',true,1,0,now() FROM kb_sale_items s WHERE s.sale_item_id=NEW.sale_item_id OR s.sale_item_id=OLD.sale_item_id",
        ),
      ],
    ];
    for (const [table, body] of triggers) {
      await tx.query(
        `CREATE OR REPLACE FUNCTION ${table}_search_dirty() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${body} RETURN NULL; END $$`,
      );
      await tx.query(
        `CREATE TRIGGER ${table}_search_dirty AFTER INSERT OR UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE PROCEDURE ${table}_search_dirty()`,
      );
    }
    await tx.query(
      "INSERT INTO kb_index_state(sale_item_id,status) SELECT sale_item_id,'pending' FROM kb_sale_items ON CONFLICT(sale_item_id) DO UPDATE SET status='pending',dirty=true,attempts=0,next_retry_at=now()",
    );
    await tx.query("INSERT INTO schema_migrations(version) VALUES(7)");
  });
  const [installed] = await db.query(
    "SELECT 1 FROM pg_extension WHERE extname='vector'",
  );
  if (installed) {
    await db.query(`CREATE TABLE IF NOT EXISTS kb_search_vectors(
      sale_item_id text NOT NULL REFERENCES kb_search_documents(sale_item_id) ON DELETE CASCADE,
      chunk_no integer NOT NULL,namespace text NOT NULL,content text NOT NULL,
      embedding vector NOT NULL,dimensions integer NOT NULL,
      PRIMARY KEY(sale_item_id,namespace,chunk_no))`);
    await db.query(
      "CREATE INDEX IF NOT EXISTS kb_search_vectors_namespace ON kb_search_vectors(namespace,sale_item_id)",
    );
  }
}
