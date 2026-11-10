import type { Database } from "./db.js";
import type {
  KnowledgeRelease,
  KnowledgeData,
} from "../shared/product-knowledge.js";
import { createHash } from "node:crypto";
import { LIVE_KNOWLEDGE_ID } from "./product-knowledge.js";
import {
  loadSemanticSettings,
  type SemanticSettings,
} from "./semantic-settings.js";
import { embeddingCache } from "./semantic-catalog.js";
import { knowledgeDocuments } from "./knowledge-documents.js";
import { documentChunks } from "./knowledge-retrieval.js";
import { retrievalTokens } from "../shared/retrieval.js";
import { vectorAvailable } from "./rag-schema.js";
import { knowledgePath } from "./structured-knowledge.js";

export function embeddingNamespace(
  settings: Pick<SemanticSettings, "baseUrl" | "model" | "revision">,
) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        settings.baseUrl,
        settings.model,
        settings.revision,
        "rag-v2",
      ]),
    )
    .digest("hex");
}
export function indexHash(
  texts: string[],
  settings: Pick<SemanticSettings, "baseUrl" | "model" | "revision">,
) {
  return createHash("sha256")
    .update(embeddingNamespace(settings))
    .update(JSON.stringify(texts))
    .digest("hex");
}
async function batchSource(
  db: Database,
  ids: string[],
): Promise<KnowledgeRelease> {
  const saleItems = await db.query<KnowledgeData["saleItems"][number]>(
    "SELECT s.* FROM kb_sale_items s JOIN kb_product_versions v USING(product_version_id) JOIN kb_products p USING(product_id) WHERE s.sale_item_id=ANY($1::text[]) AND s.status='active' AND v.status='active' AND p.status='active'",
    [ids],
  );
  const versionIds = [...new Set(saleItems.map((s) => s.product_version_id))];
  const versions = await db.query<KnowledgeData["versions"][number]>(
    "SELECT * FROM kb_product_versions WHERE product_version_id=ANY($1::text[])",
    [versionIds],
  );
  const [products, categories, dependencies] = await Promise.all([
    db.query<KnowledgeData["products"][number]>(
      "SELECT * FROM kb_products WHERE product_id=ANY($1::text[])",
      [[...new Set(versions.map((v) => v.product_id))]],
    ),
    db.query<KnowledgeData["categories"][number]>(
      "SELECT * FROM kb_categories WHERE product_version_id=ANY($1::text[])",
      [versionIds],
    ),
    db.query<KnowledgeData["dependencies"][number]>(
      "SELECT * FROM kb_sale_dependencies WHERE sale_item_id=ANY($1::text[]) ORDER BY dependency_id",
      [ids],
    ),
  ]);
  return {
    id: LIVE_KNOWLEDGE_ID,
    live: true,
    name: "PG 实时产品知识库",
    wiki_project_id: "pg",
    created_at: "",
    data: { products, versions, categories, saleItems, dependencies },
  };
}
const running = new WeakMap<Database, Promise<void>>();
const activeNamespaces = new WeakMap<Database, string>();
export async function refreshKnowledgeIndex(db: Database, signal: AbortSignal) {
  const existing = running.get(db);
  if (existing) return existing;
  const job = runIndex(db, signal);
  running.set(db, job);
  try {
    await job;
  } finally {
    if (running.get(db) === job) running.delete(db);
  }
}
async function runIndex(db: Database, signal: AbortSignal) {
  const settings = await loadSemanticSettings(db),
    namespace = settings.enabled ? embeddingNamespace(settings) : "keyword";
  const available = await vectorAvailable(db);
  // Triggers persist ordinary changes; namespace reconciliation only runs on startup/config changes.
  if (activeNamespaces.get(db) !== namespace) {
    await db.query(
      "UPDATE kb_index_state SET status='pending',attempts=0,next_retry_at=now(),generation=generation+1 WHERE namespace<>$1 AND status IN ('ready','failed')",
      [namespace],
    );
    activeNamespaces.set(db, namespace);
  }
  await db.query(
    "DELETE FROM kb_search_documents d USING kb_sale_items s,kb_product_versions v,kb_products p,kb_index_state q WHERE d.sale_item_id=s.sale_item_id AND q.sale_item_id=s.sale_item_id AND q.dirty=true AND s.product_version_id=v.product_version_id AND v.product_id=p.product_id AND (s.status<>'active' OR v.status<>'active' OR p.status<>'active')",
  );
  const vectors = embeddingCache(db, settings, signal);
  let preparedCount = 0;
  // A bounded pass keeps shutdown and other background jobs responsive on large imports.
  for (let batchNo = 0; batchNo < 8; batchNo++) {
    signal.throwIfAborted();
    const claims = await db.query<{
      sale_item_id: string;
      generation: number;
      attempts: number;
    }>(
      `WITH picked AS (
      SELECT q.sale_item_id FROM kb_index_state q JOIN kb_sale_items s USING(sale_item_id)
      JOIN kb_product_versions v USING(product_version_id) JOIN kb_products p USING(product_id)
      WHERE s.status='active' AND v.status='active' AND p.status='active' AND (
        (q.status IN ('pending','failed') AND q.attempts<5 AND q.next_retry_at<=now()) OR
        (q.status='indexing' AND q.updated_at<now()-interval '5 minutes'))
      ORDER BY q.next_retry_at,q.sale_item_id LIMIT 32 FOR UPDATE OF q SKIP LOCKED)
      UPDATE kb_index_state q SET status='indexing',attempts=attempts+1,namespace=$1,updated_at=now()
      FROM picked WHERE q.sale_item_id=picked.sale_item_id RETURNING q.sale_item_id,q.generation,q.attempts`,
      [namespace],
    );
    if (!claims.length) break;
    const source = await batchSource(
      db,
      claims.map((c) => c.sale_item_id),
    );
    const docs = knowledgeDocuments(source);
    const prepared: {
      claim: (typeof claims)[number];
      doc: (typeof docs)[number];
      chunks: string[];
      hash: string;
    }[] = [];
    for (const claim of claims) {
      signal.throwIfAborted();
      const doc = docs.find((d) => d.id === claim.sale_item_id);
      if (!doc) continue;
      const chunks = documentChunks({ ...doc, text: doc.searchText });
      const hash = indexHash(chunks, settings);
      try {
        const current = await db.transaction(async (tx) => {
          const [state] = await tx.query<{ generation: number }>(
            "SELECT generation FROM kb_index_state WHERE sale_item_id=$1 FOR UPDATE",
            [doc.id],
          );
          if (state?.generation !== claim.generation) return false;
          await tx.query(
            `INSERT INTO kb_search_documents(sale_item_id,product_id,product_version_id,category_id,title,search_text,evidence_md,payload,search_vector,source_hash,path)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,setweight(to_tsvector('simple',$9),'A')||to_tsvector('simple',$10),$11,$12)
            ON CONFLICT(sale_item_id) DO UPDATE SET product_id=$2,product_version_id=$3,category_id=$4,title=$5,search_text=$6,evidence_md=$7,payload=$8,search_vector=setweight(to_tsvector('simple',$9),'A')||to_tsvector('simple',$10),source_hash=$11,path=$12,updated_at=now()`,
            [
              doc.id,
              doc.productId,
              doc.versionId,
              doc.categoryId,
              doc.title,
              doc.searchText,
              doc.text,
              JSON.stringify({
                sale: doc.sale,
                product: doc.product,
                version: doc.version,
                category: doc.category,
              }),
              retrievalTokens(doc.title).join(" "),
              retrievalTokens(doc.searchText).join(" "),
              hash,
              knowledgePath(LIVE_KNOWLEDGE_ID, "sale-items", doc.id),
            ],
          );
          await tx.query(
            "UPDATE kb_index_state SET dirty=false WHERE sale_item_id=$1",
            [doc.id],
          );
          return true;
        });
        if (!current) continue;
        prepared.push({ claim, doc, chunks, hash });
        preparedCount++;
      } catch (error) {
        await fail(claim, error);
      }
    }
    // Batch calls to the provider instead of one HTTP request per sale item.
    try {
      let values: number[][] = [];
      if (settings.enabled && prepared.length) {
        if (!available)
          throw new Error("数据库未安装 pgvector 扩展，请安装后重试索引");
        if (!settings.baseUrl || !settings.model)
          throw new Error("Embedding 配置不完整");
        values = await vectors(prepared.flatMap((item) => item.chunks));
      }
      let offset = 0;
      for (const { claim, doc, chunks, hash } of prepared) {
        const embedded = settings.enabled
          ? values.slice(offset, offset + chunks.length)
          : [];
        offset += chunks.length;
        try {
          await db.transaction(async (tx) => {
            const [state] = await tx.query<{ generation: number }>(
              "SELECT generation FROM kb_index_state WHERE sale_item_id=$1 FOR UPDATE",
              [doc.id],
            );
            if (state?.generation !== claim.generation) return;
            if (available) {
              await tx.query(
                "DELETE FROM kb_search_vectors WHERE sale_item_id=$1",
                [doc.id],
              );
              for (let i = 0; i < embedded.length; i++)
                await tx.query(
                  "INSERT INTO kb_search_vectors(sale_item_id,chunk_no,namespace,content,embedding,dimensions) VALUES($1,$2,$3,$4,$5::vector,$6)",
                  [
                    doc.id,
                    i,
                    namespace,
                    chunks[i],
                    JSON.stringify(embedded[i]),
                    embedded[i].length,
                  ],
                );
            }
            await tx.query(
              "UPDATE kb_index_state SET input_hash=$2,namespace=$3,status='ready',error=NULL,updated_at=now() WHERE sale_item_id=$1",
              [doc.id, hash, namespace],
            );
          });
        } catch (error) {
          await fail(claim, error);
        }
      }
    } catch (error) {
      for (const { claim } of prepared) await fail(claim, error);
      if (signal.aborted) throw error;
    }
    // Yield to the event loop; no synchronous full-catalog preparation on the query path.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    async function fail(claim: (typeof claims)[number], error: unknown) {
      const aborted = signal.aborted;
      await db.query(
        `UPDATE kb_index_state SET status=$3,error=$4,next_retry_at=now()+($5::integer*interval '1 second'),updated_at=now()
        WHERE sale_item_id=$1 AND generation=$2 AND status='indexing'`,
        [
          claim.sale_item_id,
          claim.generation,
          aborted ? "pending" : "failed",
          aborted
            ? null
            : String(
                error instanceof Error ? error.message : "索引生成失败",
              ).slice(0, 500),
          aborted ? 0 : Math.min(300, 2 ** claim.attempts * 5),
        ],
      );
    }
  }
  if (preparedCount) {
    // Fresh bulk loads otherwise produce severely underestimated join cardinalities.
    // Analyze derived tables, never the administrator-owned source tables.
    await db.query("ANALYZE kb_search_documents");
    await db.query("ANALYZE kb_index_state");
    if (available) await db.query("ANALYZE kb_search_vectors");
  }
}

export async function retryKnowledgeIndex(db: Database, rebuild = false) {
  await db.query(
    rebuild
      ? "UPDATE kb_index_state SET status='pending',dirty=true,attempts=0,generation=generation+1,next_retry_at=now(),error=NULL"
      : "UPDATE kb_index_state SET status='pending',attempts=0,generation=generation+1,next_retry_at=now(),error=NULL WHERE status='failed'",
  );
}
