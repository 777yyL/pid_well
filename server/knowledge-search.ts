import { z } from "zod";
import type { Database } from "./db.js";
import type {
  KnowledgeRelease,
  KnowledgeData,
} from "../shared/product-knowledge.js";
import { knowledgeChoice, knowledgePath } from "./structured-knowledge.js";
import { LIVE_KNOWLEDGE_ID } from "./product-knowledge.js";
import { AppError } from "./errors.js";
import { loadSemanticSettings } from "./semantic-settings.js";
import { embeddingCache } from "./semantic-catalog.js";
import {
  embeddingNamespace,
  refreshKnowledgeIndex,
} from "./retrieval-index.js";
import { vectorAvailable } from "./rag-schema.js";
import { retrievalTokens } from "../shared/retrieval.js";
import { loadRerankSettings, requestRerank } from "./reranker.js";
export { knowledgeDocuments } from "./knowledge-documents.js";
export { indexHash, refreshKnowledgeIndex } from "./retrieval-index.js";

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
export async function selectedVersionIds(
  db: Database,
  projectId: string,
  source?: KnowledgeRelease,
) {
  const [scope] = await db.query<{
    status: string;
    selected: { name: string; version: string; path?: string }[];
  }>("SELECT status,selected FROM product_scopes WHERE project_id=$1", [
    projectId,
  ]);
  if (scope?.status !== "confirmed" || !scope.selected.length)
    throw new AppError(409, "请先确认产品与版本，检索不会自动扩大范围");
  if (!source) {
    const [products, versions] = await Promise.all([
      db.query<KnowledgeData["products"][number]>(
        "SELECT * FROM kb_products WHERE status='active'",
      ),
      db.query<KnowledgeData["versions"][number]>(
        "SELECT * FROM kb_product_versions WHERE status='active'",
      ),
    ]);
    source = {
      id: LIVE_KNOWLEDGE_ID,
      live: true,
      name: "PG",
      wiki_project_id: "pg",
      created_at: "",
      data: {
        products,
        versions,
        categories: [],
        saleItems: [],
        dependencies: [],
      },
    };
  }
  return scope.selected.map(
    (choice) => knowledgeChoice(source!, choice).version.product_version_id,
  );
}

type Ranked = {
  sale_item_id: string;
  source_hash: string;
  generation: number;
  keyword_score: number;
  vector_similarity: number | null;
  score: number;
};
type IndexedDocument = {
  sale_item_id: string;
  source_hash: string;
  generation: number;
  title: string;
  search_text: string;
  evidence_md: string;
  payload: {
    sale: KnowledgeData["saleItems"][number];
    product: KnowledgeData["products"][number];
    version: KnowledgeData["versions"][number];
    category: string;
  };
};
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
  const started = Date.now(),
    input = knowledgeSearchSchema.parse(raw);
  const [settings, rerankSettings] = await Promise.all([
    loadSemanticSettings(db),
    loadRerankSettings(db),
  ]);
  const mode = input.mode ?? settings.mode,
    topK = input.topK ?? settings.topK;
  const minSimilarity =
    input.minSimilarity === null
      ? undefined
      : (input.minSimilarity ?? settings.minSimilarity);
  const scopedVersions = options.projectId
    ? await selectedVersionIds(db, options.projectId, options.source)
    : null;
  const namespace = embeddingNamespace(settings);
  const signal =
    options.signal ??
    AbortSignal.timeout(Math.max(settings.timeoutMs * 2, 30000));
  signal.throwIfAborted();
  const read = async <T>(sql: string, values: unknown[]) => {
    signal.throwIfAborted();
    try {
      const rows = await db.transaction(async (tx) => {
        await tx.query(
          `SET LOCAL statement_timeout = ${Math.min(settings.timeoutMs, 10000)}`,
        );
        return tx.query<T>(sql, values);
      });
      signal.throwIfAborted();
      return rows;
    } catch (error) {
      if ((error as { code?: string }).code === "57014")
        throw new AppError(504, "数据库检索超时，请检查索引状态与数据库负载");
      throw error;
    }
  };
  const available = await vectorAvailable(db);
  if (mode !== "keyword") {
    if (!settings.enabled || !settings.baseUrl || !settings.model)
      throw new AppError(
        409,
        "Embedding 未启用或配置不完整，无法执行向量/混合检索；可明确选择关键词检索",
      );
    if (!available)
      throw new AppError(
        409,
        "数据库未启用 pgvector 扩展，请由管理员安装；未切换检索模式",
      );
  }
  // All filters form the SQL candidate set BEFORE either keyword or vector ranking.
  const allowedPaths = options.allowedPaths ? [...options.allowedPaths] : null;
  const params: unknown[] = [
    input.productIds,
    input.versionIds,
    input.categoryIds,
    allowedPaths,
    scopedVersions,
  ];
  const conditions = `s.status='active' AND v.status='active' AND p.status='active'
    AND (cardinality($1::text[])=0 OR p.product_id=ANY($1::text[]))
    AND (cardinality($2::text[])=0 OR v.product_version_id=ANY($2::text[]))
    AND (cardinality($3::text[])=0 OR COALESCE(s.category_id,'__uncategorized__')=ANY($3::text[]))
    AND ($4::text[] IS NULL OR ('wiki/structured/${LIVE_KNOWLEDGE_ID}/sale-items/'||encode(sha256(convert_to(s.sale_item_id,'UTF8')),'hex')||'.md')=ANY($4::text[]))
    AND ($5::text[] IS NULL OR v.product_version_id=ANY($5::text[]))`;
  const joins = `FROM kb_sale_items s JOIN kb_product_versions v USING(product_version_id) JOIN kb_products p USING(product_id)
    LEFT JOIN kb_search_documents d ON d.sale_item_id=s.sale_item_id LEFT JOIN kb_index_state q ON q.sale_item_id=s.sale_item_id`;
  const ready = `d.sale_item_id IS NOT NULL AND q.dirty=false${mode === "keyword" ? "" : " AND q.status='ready' AND q.namespace=$6"}`;
  const statsParams = mode === "keyword" ? params : [...params, namespace];
  const [counts] = await read<{
    total: number;
    ready: number;
    failed: number;
  }>(
    `SELECT count(*)::int total,
    count(*) FILTER(WHERE ${ready})::int ready,
    count(*) FILTER(WHERE q.status='failed' AND NOT COALESCE((${ready}),false))::int failed ${joins} WHERE ${conditions}`,
    statsParams,
  );
  const index = {
    ...counts,
    pending: counts.total - counts.ready - counts.failed,
  };
  const warnings: string[] = [];
  if (index.pending || index.failed)
    warnings.push(
      `当前范围 ${index.total} 项，${index.ready} 项可用于本次检索，${index.pending} 项待索引、${index.failed} 项失败；未命中不代表产品不支持。`,
    );
  const timings = {
    loadMs: Date.now() - started,
    embeddingMs: 0,
    retrievalMs: 0,
    rerankMs: 0,
    totalMs: 0,
  };
  let vector: number[] | undefined;
  if (mode !== "keyword" && index.ready) {
    const time = Date.now();
    try {
      [vector] = await embeddingCache(db, settings, signal)([input.query]);
    } catch (e) {
      throw new AppError(
        502,
        `查询向量生成失败：${e instanceof Error ? e.message : "Embedding 异常"}；未切换检索模式`,
      );
    }
    timings.embeddingMs = Date.now() - time;
  }
  signal.throwIfAborted();
  const retrievalStart = Date.now();
  const limit = rerankSettings.enabled
    ? Math.max(topK, rerankSettings.candidateLimit)
    : Math.min(100, topK * 3);
  const query = retrievalTokens(input.query)
    .map((t) => "'" + t.replace(/'/g, "''") + "'")
    .join(" | ");
  const sqlParams = [
    ...params,
    namespace,
    vector ? JSON.stringify(vector) : null,
    vector?.length ?? 0,
    minSimilarity ?? null,
    limit,
  ];
  const scoped = `SELECT d.sale_item_id,d.search_vector,d.source_hash,q.generation,q.namespace,q.status ${joins} WHERE ${conditions} AND d.sale_item_id IS NOT NULL AND q.dirty=false`;
  const cte =
    mode === "keyword"
      ? `WITH scoped AS NOT MATERIALIZED (${scoped}), scored AS (SELECT scoped.*,NULL::double precision vector_similarity FROM scoped)`
      : `WITH scoped AS MATERIALIZED (${scoped}), distances AS MATERIALIZED (
        SELECT d.sale_item_id,d.search_vector,d.source_hash,d.generation,
        max(CASE WHEN e.dimensions=$8 THEN 1-(e.embedding <=> $7::vector) END) vector_similarity
        FROM kb_search_vectors e JOIN scoped d USING(sale_item_id)
        WHERE e.namespace=$6 AND d.status='ready' AND d.namespace=$6
        GROUP BY d.sale_item_id,d.search_vector,d.source_hash,d.generation),
      scored AS (SELECT * FROM distances
        WHERE ($9::double precision IS NULL OR vector_similarity >= $9))`;
  let keyword: Ranked[] = [],
    semantic: Ranked[] = [];
  if (index.ready) {
    if (vector) {
      const [dimensions] = await read<{ invalid: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM kb_search_vectors e JOIN kb_sale_items s USING(sale_item_id)
        JOIN kb_product_versions v USING(product_version_id) JOIN kb_products p USING(product_id)
        WHERE ${conditions} AND e.namespace=$6 AND e.dimensions<>$7) invalid`,
        [...params, namespace, vector.length],
      );
      if (dimensions.invalid)
        throw new AppError(
          409,
          "查询向量与索引维度不一致，请更新模型版本并重建索引",
        );
    }
    if (mode !== "vector" && query) {
      const queryParam = mode === "keyword" ? "$6" : "$11";
      const limitParam = mode === "keyword" ? "$7" : "$10";
      keyword = await read<Ranked>(
        `${cte} SELECT sale_item_id,source_hash,generation,
      ts_rank_cd(search_vector,to_tsquery('simple',${queryParam}))::double precision keyword_score,vector_similarity,0::double precision score
      FROM scored WHERE search_vector @@ to_tsquery('simple',${queryParam})
      ORDER BY keyword_score DESC,sale_item_id LIMIT ${limitParam}`,
        mode === "keyword" ? [...params, query, limit] : [...sqlParams, query],
      );
    }
    if (mode !== "keyword" && vector)
      semantic = await read<Ranked>(
        `${cte} SELECT sale_item_id,source_hash,generation,0::double precision keyword_score,vector_similarity,0::double precision score
      FROM scored WHERE vector_similarity IS NOT NULL
      ORDER BY vector_similarity DESC,sale_item_id LIMIT $10`,
        sqlParams,
      );
  }
  const merged = new Map<string, Ranked>();
  for (const [kind, rows] of [
    ["keyword", keyword],
    ["vector", semantic],
  ] as const)
    rows.forEach((row, i) => {
      const existing = merged.get(row.sale_item_id) ?? { ...row, score: 0 };
      existing.keyword_score = Math.max(
        existing.keyword_score,
        row.keyword_score,
      );
      existing.vector_similarity =
        row.vector_similarity ?? existing.vector_similarity;
      existing.score +=
        mode === "hybrid"
          ? 1 / (60 + i + 1)
          : kind === "keyword"
            ? row.keyword_score
            : (row.vector_similarity ?? 0);
      merged.set(row.sale_item_id, existing);
    });
  let hits = [...merged.values()]
    .sort(
      (a, b) =>
        b.score - a.score || a.sale_item_id.localeCompare(b.sale_item_id),
    )
    .slice(0, limit);
  const documents = hits.length
    ? await read<IndexedDocument>(
        `SELECT d.*,q.generation ${joins} WHERE ${conditions} AND d.sale_item_id=ANY($6::text[]) AND q.dirty=false`,
        [...params, hits.map((h) => h.sale_item_id)],
      )
    : [];
  const byId = new Map(documents.map((d) => [d.sale_item_id, d]));
  hits = hits.filter((h) => {
    const doc = byId.get(h.sale_item_id);
    return (
      doc?.source_hash === h.source_hash && doc.generation === h.generation
    );
  });
  timings.retrievalMs = Date.now() - retrievalStart;
  let applied = false;
  const rerankScores = new Map<string, number>();
  if (rerankSettings.enabled && hits.length) {
    const time = Date.now();
    try {
      const ranked = await requestRerank(
        input.query,
        hits.map((h) => byId.get(h.sale_item_id)!.search_text),
        rerankSettings,
        signal,
      );
      const original = hits;
      hits = ranked.map((r) => {
        const hit = original[r.index];
        rerankScores.set(hit.sale_item_id, r.score);
        return hit;
      });
      applied = true;
    } catch {
      signal.throwIfAborted();
      warnings.push(
        "精排服务未完成，本次保留召回排序；请检查精排连接或超时配置。",
      );
    }
    timings.rerankMs = Date.now() - time;
  }
  const validationStart = Date.now();
  if (hits.length) {
    const current = await read<{
      sale_item_id: string;
      source_hash: string;
      generation: number;
    }>(
      `SELECT d.sale_item_id,d.source_hash,q.generation ${joins} WHERE ${conditions} AND d.sale_item_id=ANY($6::text[]) AND q.dirty=false`,
      [...params, hits.map((h) => h.sale_item_id)],
    );
    const unchanged = new Map(current.map((row) => [row.sale_item_id, row]));
    const previous = hits.length;
    hits = hits.filter((hit) => {
      const row = unchanged.get(hit.sale_item_id);
      return (
        row?.source_hash === hit.source_hash &&
        row.generation === hit.generation
      );
    });
    if (hits.length !== previous)
      warnings.push(
        "部分销售项在查询期间发生变化，已移除过期候选，请重新检索。",
      );
  }
  timings.retrievalMs += Date.now() - validationStart;
  timings.totalMs = Date.now() - started;
  return {
    query: input.query,
    mode,
    topK,
    minSimilarity: mode === "keyword" ? undefined : minSimilarity,
    scopeVersionIds: scopedVersions ?? input.versionIds,
    scopedItemCount: index.total,
    elapsedMs: timings.totalMs,
    engine: mode === "keyword" ? "postgres-fts" : "pgvector-exact",
    timings,
    index,
    warnings,
    rerank: { enabled: rerankSettings.enabled, applied },
    results: hits.slice(0, topK).map((hit) => {
      const doc = byId.get(hit.sale_item_id)!,
        { sale, product, version, category } = doc.payload;
      return {
        saleItemId: hit.sale_item_id,
        title: doc.title,
        productId: product.product_id,
        product: product.product_code,
        productName: product.name,
        productVersionId: version.product_version_id,
        version: version.version,
        categoryId: sale.category_id,
        category,
        moduleId: sale.module_code ?? "",
        path: knowledgePath(LIVE_KNOWLEDGE_ID, "sale-items", hit.sale_item_id),
        summary: sale.description || sale.specification_md?.slice(0, 800) || "",
        score: hit.score,
        keywordScore: hit.keyword_score,
        vectorSimilarity: hit.vector_similarity,
        rerankScore: rerankScores.get(hit.sale_item_id),
        ...(input.includeContent
          ? { content: doc.evidence_md, specification: sale.specification_md }
          : {}),
      };
    }),
  };
}

export function startKnowledgeIndexer(db: Database) {
  const controller = new AbortController();
  let indexJob: Promise<unknown> | undefined,
    overviewJob: Promise<unknown> | undefined;
  const tick = () => {
    if (!indexJob)
      indexJob = refreshKnowledgeIndex(db, controller.signal)
        .catch(() => undefined)
        .finally(() => {
          indexJob = undefined;
        });
  };
  const timer = setInterval(tick, 2000);
  timer.unref();
  tick();
  const overviewTimer = setInterval(() => {
    if (!overviewJob)
      overviewJob = import("./product-overviews.js")
        .then((m) => m.refreshProductOverviews(db, controller.signal))
        .catch(() => undefined)
        .finally(() => {
          overviewJob = undefined;
        });
  }, 30000);
  overviewTimer.unref();
  return async () => {
    clearInterval(timer);
    clearInterval(overviewTimer);
    controller.abort();
    await Promise.allSettled([indexJob, overviewJob]);
  };
}
