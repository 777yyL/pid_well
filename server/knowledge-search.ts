import { z } from "zod";
import type { Database } from "./db.js";
import type { KnowledgeRelease } from "../shared/product-knowledge.js";
import { liveKnowledge } from "./product-knowledge.js";
import {
  knowledgeChoice,
  knowledgePath,
  saleMarkdown,
} from "./structured-knowledge.js";
import { AppError } from "./errors.js";
import { loadSemanticSettings } from "./semantic-settings.js";
import { embeddingCache } from "./semantic-catalog.js";
import { documentChunks, rankKnowledge } from "./knowledge-retrieval.js";
import { createHash } from "node:crypto";

export const knowledgeSearchSchema = z.object({
  query: z.string().trim().min(1).max(4000),
  mode: z.enum(["keyword", "vector", "hybrid"]).optional(),
  topK: z.number().int().min(1).max(100).optional(),
  minSimilarity: z.number().min(-1).max(1).nullable().optional(),
  productIds: z.array(z.string().min(1)).max(100).default([]),
  versionIds: z.array(z.string().min(1)).max(100).default([]),
  categoryIds: z.array(z.string().min(1)).max(100).default([]),
  includeContent: z.boolean().default(false),
});
export type KnowledgeSearchInput = z.input<typeof knowledgeSearchSchema>;
export function knowledgeDocuments(
  source: KnowledgeRelease,
  sales = source.data.saleItems,
) {
  return sales.map((sale) => {
    const version = source.data.versions.find(
      (v) => v.product_version_id === sale.product_version_id,
    )!;
    const product = source.data.products.find(
      (p) => p.product_id === version.product_id,
    )!;
    return {
      id: sale.sale_item_id,
      title: sale.name,
      productId: product.product_id,
      versionId: version.product_version_id,
      categoryId: sale.category_id,
      text: saleMarkdown(source, sale),
      sale,
      product,
      version,
    };
  });
}
export async function selectedVersionIds(
  db: Database,
  projectId: string,
  source: KnowledgeRelease,
) {
  const [scope] = await db.query<{
    status: string;
    selected: { name: string; version: string; path?: string }[];
  }>("SELECT status,selected FROM product_scopes WHERE project_id=$1", [
    projectId,
  ]);
  if (scope?.status !== "confirmed" || !scope.selected.length)
    throw new AppError(409, "请先确认产品与版本，检索不会自动扩大范围");
  return scope.selected.map(
    (choice) => knowledgeChoice(source, choice).version.product_version_id,
  );
}
export async function searchKnowledge(
  db: Database,
  raw: KnowledgeSearchInput,
  options: {
    projectId?: string;
    signal?: AbortSignal;
    source?: KnowledgeRelease;
    allowedPaths?: Set<string>;
  } = {},
) {
  const input = knowledgeSearchSchema.parse(raw),
    started = Date.now();
  const source = options.source ?? (await liveKnowledge(db));
  const settings = await loadSemanticSettings(db);
  const mode = input.mode ?? settings.mode,
    topK = input.topK ?? settings.topK;
  const minSimilarity =
    input.minSimilarity === null
      ? undefined
      : (input.minSimilarity ?? settings.minSimilarity);
  const scopedVersions = options.projectId
    ? await selectedVersionIds(db, options.projectId, source)
    : null;
  const versions = new Set(
    source.data.versions
      .filter(
        (v) =>
          (!scopedVersions || scopedVersions.includes(v.product_version_id)) &&
          (!input.productIds.length ||
            input.productIds.includes(v.product_id)) &&
          (!input.versionIds.length ||
            input.versionIds.includes(v.product_version_id)),
      )
      .map((v) => v.product_version_id),
  );
  const documents = knowledgeDocuments(
    source,
    source.data.saleItems.filter(
      (s) =>
        versions.has(s.product_version_id) &&
        (!input.categoryIds.length ||
          input.categoryIds.includes(s.category_id ?? "__uncategorized__")) &&
        (!options.allowedPaths ||
          options.allowedPaths.has(
            knowledgePath(source.id, "sale-items", s.sale_item_id),
          )),
    ),
  );
  if (
    mode !== "keyword" &&
    (!settings.enabled || !settings.baseUrl || !settings.model)
  )
    throw new AppError(
      409,
      "Embedding 未启用或配置不完整，无法执行向量/混合检索；可明确选择关键词检索",
    );
  const signal =
    options.signal ??
    AbortSignal.timeout(Math.max(settings.timeoutMs * 4, 120000));
  try {
    const hits = await rankKnowledge(
      documents,
      input.query,
      { mode, topK, minSimilarity },
      mode === "keyword" ? undefined : embeddingCache(db, settings, signal),
    );
    return {
      query: input.query,
      mode,
      topK,
      minSimilarity: mode === "keyword" ? undefined : minSimilarity,
      scopeVersionIds: scopedVersions ?? input.versionIds,
      scopedItemCount: documents.length,
      elapsedMs: Date.now() - started,
      results: hits.map((hit) => ({
        saleItemId: hit.id,
        title: hit.title,
        productId: hit.productId,
        product: hit.product.product_code,
        productName: hit.product.name,
        productVersionId: hit.versionId,
        version: hit.version.version,
        categoryId: hit.categoryId,
        category:
          source.data.categories.find((c) => c.category_id === hit.categoryId)
            ?.name ?? "未分类",
        moduleId: hit.sale.module_code ?? "",
        path: knowledgePath(source.id, "sale-items", hit.id),
        summary:
          hit.sale.description ||
          hit.sale.specification_md?.slice(0, 800) ||
          "",
        score: hit.score,
        keywordScore: hit.keywordScore,
        vectorSimilarity: hit.vectorSimilarity,
        ...(input.includeContent
          ? {
              content: saleMarkdown(source, hit.sale),
              specification: hit.sale.specification_md,
            }
          : {}),
      })),
    };
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError(
      502,
      `知识检索未完成：${e instanceof Error ? e.message : "Embedding 服务异常"}；未切换检索模式`,
    );
  }
}

export function indexHash(
  texts: string[],
  settings: { baseUrl: string; model: string; revision: string },
) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        settings.baseUrl,
        settings.model,
        settings.revision,
        texts,
      ]),
    )
    .digest("hex");
}
const indexing = new WeakMap<Database, Promise<void>>();
export async function refreshKnowledgeIndex(db: Database, signal: AbortSignal) {
  if (indexing.has(db)) return indexing.get(db)!;
  const job = (async () => {
    const settings = await loadSemanticSettings(db);
    if (!settings.enabled || !settings.baseUrl || !settings.model) return;
    const source = await liveKnowledge(db);
    const vectors = embeddingCache(db, settings, signal);
    const states = await db.query<{
      sale_item_id: string;
      input_hash: string;
      status: string;
    }>("SELECT * FROM kb_index_state");
    const pending = knowledgeDocuments(source)
      .map((doc) => ({
        id: doc.id,
        chunks: documentChunks(doc),
        hash: indexHash(documentChunks(doc), settings),
      }))
      .filter(
        (doc) =>
          !states.some(
            (s) =>
              s.sale_item_id === doc.id &&
              s.input_hash === doc.hash &&
              s.status === "ready",
          ),
      );
    for (let offset = 0; offset < pending.length; offset += 32) {
      signal.throwIfAborted();
      const batch = pending.slice(offset, offset + 32),
        ids = batch.map((d) => d.id);
      await db.query(
        `INSERT INTO kb_index_state(sale_item_id,input_hash,status,error)
        SELECT x.id,x.hash,'indexing',NULL FROM unnest($1::text[],$2::text[]) AS x(id,hash)
        ON CONFLICT(sale_item_id) DO UPDATE SET input_hash=EXCLUDED.input_hash,status='indexing',error=NULL,updated_at=now()`,
        [ids, batch.map((d) => d.hash)],
      );
      try {
        await vectors(batch.flatMap((d) => d.chunks));
        await db.query(
          "UPDATE kb_index_state SET status='ready',error=NULL,updated_at=now() WHERE sale_item_id=ANY($1::text[])",
          [ids],
        );
      } catch (error) {
        await db.query(
          "UPDATE kb_index_state SET status='failed',error=$2,updated_at=now() WHERE sale_item_id=ANY($1::text[])",
          [ids, (error as Error).message.slice(0, 500)],
        );
        throw error;
      }
    }
  })();
  indexing.set(db, job);
  try {
    await job;
  } finally {
    indexing.delete(db);
  }
}
export function startKnowledgeIndexer(db: Database) {
  const controller = new AbortController();
  let overviewJob: Promise<unknown> | undefined;
  const tick = () => {
    void refreshKnowledgeIndex(db, controller.signal).catch(() => undefined);
    if (!overviewJob)
      overviewJob = import("./product-overviews.js")
        .then((m) => m.refreshProductOverviews(db, controller.signal))
        .catch(() => undefined)
        .finally(() => {
          overviewJob = undefined;
        });
  };
  const timer = setInterval(tick, 30000);
  timer.unref();
  tick();
  return async () => {
    clearInterval(timer);
    controller.abort();
    await Promise.allSettled([indexing.get(db), overviewJob]);
  };
}
