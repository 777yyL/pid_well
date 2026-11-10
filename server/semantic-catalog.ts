import {
  defaultSemanticSettings,
  loadSemanticSettings,
  type SemanticSettings,
} from "./semantic-settings.js";
import { createHash } from "node:crypto";
import type { Database } from "./db.js";
import type { CatalogContext } from "./catalog-context.js";
import type { RequirementInput } from "../shared/domain.js";
import { retrievalTokens } from "../shared/retrieval.js";
import { catalogPackets } from "./catalog-context.js";

import { prepareKnowledgeRanker } from "./knowledge-retrieval.js";
export { cosine } from "./knowledge-retrieval.js";

type Embed = (texts: string[], signal: AbortSignal) => Promise<number[][]>;
export async function requestEmbeddings(
  texts: string[],
  signal: AbortSignal,
  settings: SemanticSettings = defaultSemanticSettings(),
) {
  const url = settings.baseUrl.replace(/\/$/, "") + "/embeddings";
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(settings.apiKey
        ? { Authorization: `Bearer ${settings.apiKey}` }
        : {}),
    },
    body: JSON.stringify({
      model: settings.model,
      input: texts,
      encoding_format: "float",
    }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(settings.timeoutMs)]),
  });
  if (!response.ok)
    throw new Error(`Embedding 请求失败（HTTP ${response.status}）`);
  const body = (await response.json()) as {
    data?: { index: number; embedding: number[] }[];
  };
  const data = body.data;
  if (
    !Array.isArray(data) ||
    data.length !== texts.length ||
    new Set(data.map((d) => d.index)).size !== texts.length
  )
    throw new Error("Embedding 返回条数或索引无效");
  data.sort((a, b) => a.index - b.index);
  const vectors = data.map((d, i) => {
    if (
      d.index !== i ||
      !Array.isArray(d.embedding) ||
      !d.embedding.length ||
      !d.embedding.every(Number.isFinite) ||
      !d.embedding.some((v) => v !== 0)
    )
      throw new Error("Embedding 返回无效向量");
    return d.embedding;
  });
  if (vectors.some((v) => v.length !== vectors[0].length))
    throw new Error("Embedding 返回维度不一致");
  return vectors;
}

// A few hundred scoped items use exact cosine ranking. Persist vectors in PG JSONB;
// no extension or additional database is needed for the current catalog size.
export async function prepareSemanticCatalog(
  db: Database,
  context: CatalogContext,
  signal: AbortSignal,
  embed?: Embed,
) {
  const settings = await loadSemanticSettings(db);
  const generate =
    embed ??
    ((texts: string[], signal: AbortSignal) =>
      requestEmbeddings(texts, signal, settings));
  const persistentVectors = embeddingCache(db, settings, signal, generate);
  // Bounded by this catalog/search lifecycle, never shared across tasks or scopes.
  const local = new Map<string, number[]>();
  const vectors = async (texts: string[]) => {
    const missing = [...new Set(texts.filter((text) => !local.has(text)))];
    if (missing.length) {
      const values = await persistentVectors(missing);
      missing.forEach((text, i) => local.set(text, values[i]));
    }
    return texts.map((text) => local.get(text)!);
  };
  const documents = context.index.map((entry, i) => ({
    id: entry.id,
    title: entry.sales,
    productId: entry.product,
    versionId: entry.version,
    text: context.candidates[i].excerpts.map((e) => e.quote).join("\n"),
  }));
  const rank = await prepareKnowledgeRanker(
    documents,
    settings.mode !== "keyword" && settings.enabled ? vectors : undefined,
  );
  // Index only this already-scoped catalog; no global candidate pool is consulted.
  return async (requirements: RequirementInput[], limit = settings.topK) => {
    const queries = requirements.map((r) => [
      ...new Set([
        r.raw,
        ...(r.subrequirements?.map((s) => s.raw) ?? []),
        ...r.raw
          .split(/[；;。\n]/)
          .map((s) => s.trim())
          .filter((s) => s.length > 5),
      ]),
    ]);
    if (settings.mode !== "keyword" && settings.enabled)
      await vectors(queries.flat());
    const selections = [];
    for (let i = 0; i < requirements.length; i++) {
      const r = requirements[i];
      signal.throwIfAborted();
      const fused = new Map<string, number>();
      for (const query of queries[i]) {
        const hits = await rank(query, {
          mode: settings.mode,
          topK: Math.min(100, limit * 2),
          minSimilarity: settings.minSimilarity,
        });
        hits.forEach((h, j) =>
          fused.set(h.id, (fused.get(h.id) ?? 0) + 1 / (60 + j + 1)),
        );
      }
      selections.push({
        requirementId: r.id,
        catalogIds: [...fused]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .slice(0, limit)
          .map(([id]) => id),
      });
    }
    return catalogPackets(context, requirements, { selections });
  };
}

const pendingEmbeddings = new WeakMap<
  Database,
  Map<string, Promise<number[]>>
>();
export function embeddingCache(
  db: Database,
  settings: SemanticSettings,
  signal: AbortSignal,
  generate: Embed = (texts, signal) =>
    requestEmbeddings(texts, signal, settings),
) {
  const namespace = `${settings.baseUrl}|${settings.model}|${settings.revision}|catalog-v1`;
  return async function vectors(texts: string[]) {
    if (!texts.length) return [];
    const keys = texts.map((text) =>
      createHash("sha256")
        .update(namespace + "\n" + text)
        .digest("hex"),
    );
    const rows = await db.query<{ cache_key: string; embedding: number[] }>(
      "SELECT cache_key,embedding FROM embedding_cache WHERE cache_key=ANY($1::text[])",
      [keys],
    );
    const cached = new Map(rows.map((r) => [r.cache_key, r.embedding]));
    const pending =
      pendingEmbeddings.get(db) ?? new Map<string, Promise<number[]>>();
    pendingEmbeddings.set(db, pending);
    const owned = new Map<
      string,
      { resolve: (v: number[]) => void; reject: (error: unknown) => void }
    >();
    const missing = [...new Set(keys.filter((key) => !cached.has(key)))];
    for (const key of missing)
      if (!pending.has(key)) {
        const promise = new Promise<number[]>((resolve, reject) =>
          owned.set(key, { resolve, reject }),
        );
        void promise.catch(() => undefined);
        pending.set(key, promise);
      }
    // Capture shared promises before the owner resolves and releases their map entries.
    const waiting = new Map(missing.map((key) => [key, pending.get(key)!]));
    try {
      const mine = [...owned.keys()];
      for (let offset = 0; offset < mine.length; offset += 32) {
        signal.throwIfAborted();
        const part = mine.slice(offset, offset + 32);
        const values = await generate(
          part.map((key) => texts[keys.indexOf(key)]),
          signal,
        );
        await db.query(
          `INSERT INTO embedding_cache(cache_key,embedding)
          SELECT x.key,x.value::jsonb FROM unnest($1::text[],$2::text[]) AS x(key,value)
          ON CONFLICT(cache_key) DO NOTHING`,
          [part, values.map((value) => JSON.stringify(value))],
        );
        part.forEach((key, i) => {
          owned.get(key)!.resolve(values[i]);
          pending.delete(key);
        });
      }
      for (const [key, promise] of waiting) cached.set(key, await promise);
      signal.throwIfAborted();
      return keys.map((key) => cached.get(key)!);
    } catch (error) {
      for (const [key, deferred] of owned) {
        deferred.reject(error);
        pending.delete(key);
      }
      throw error;
    }
  };
}
