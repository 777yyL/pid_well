import { retrievalTokens } from "../shared/retrieval.js";

export type SearchMode = "keyword" | "vector" | "hybrid";
export interface RetrievalDocument {
  id: string;
  title: string;
  text: string;
  productId: string;
  versionId: string;
  categoryId?: string | null;
}
export interface RetrievalOptions {
  mode: SearchMode;
  topK: number;
  minSimilarity?: number;
}
export type EmbedTexts = (texts: string[]) => Promise<number[][]>;
export function cosine(a: number[], b: number[]) {
  if (!a.length || a.length !== b.length)
    throw new Error("Embedding 向量维度不一致");
  let dot = 0,
    aa = 0,
    bb = 0;
  for (let i = 0; i < a.length; i++) {
    if (!Number.isFinite(a[i]) || !Number.isFinite(b[i]))
      throw new Error("Embedding 向量无效");
    dot += a[i] * b[i];
    aa += a[i] ** 2;
    bb += b[i] ** 2;
  }
  return aa && bb ? Math.max(-1, Math.min(1, dot / Math.sqrt(aa * bb))) : 0;
}
export function documentChunks(doc: RetrievalDocument) {
  const text = doc.text || doc.title;
  return Array.from(
    { length: Math.ceil(text.length / 1400) || 1 },
    (_, i) => doc.title + "\n" + text.slice(i * 1400, i * 1400 + 1600),
  );
}
// The caller supplies the authorized product/version set BEFORE any ranking or embedding.
export async function rankKnowledge<T extends RetrievalDocument>(
  documents: T[],
  query: string,
  options: RetrievalOptions,
  embed?: EmbedTexts,
) {
  const rank = await prepareKnowledgeRanker(
    documents,
    options.mode === "keyword" ? undefined : embed,
  );
  return rank(query, options);
}
export async function prepareKnowledgeRanker<T extends RetrievalDocument>(
  documents: T[],
  embed?: EmbedTexts,
) {
  const chunks = embed
    ? documents.flatMap((doc, index) =>
        documentChunks(doc).map((text) => ({ index, text })),
      )
    : [];
  const embedded =
    embed && chunks.length ? await embed(chunks.map((c) => c.text)) : [];
  return async (query: string, options: RetrievalOptions) => {
    const terms = retrievalTokens(query);
    const rows = documents.map((doc) => {
      const name = doc.title.toLowerCase(),
        text = doc.text.toLowerCase();
      const keywordScore = terms.reduce(
        (sum, t) => sum + (name.includes(t) ? 4 : text.includes(t) ? 1 : 0),
        0,
      );
      return {
        ...doc,
        keywordScore,
        vectorSimilarity: null as number | null,
        score: 0,
      };
    });
    if (options.mode !== "keyword") {
      if (!embed) throw new Error("Embedding 未配置，无法执行向量或混合检索");
      if (!rows.length) return rows;
      const [vector] = await embed([query]);
      chunks.forEach((chunk, i) => {
        const score = cosine(vector, embedded[i]);
        rows[chunk.index].vectorSimilarity = Math.max(
          rows[chunk.index].vectorSimilarity ?? -1,
          score,
        );
      });
    }
    // Similarity is a cosine threshold, never a threshold on RRF or keyword scores.
    const eligible = rows.filter(
      (r) =>
        options.mode === "keyword" ||
        options.minSimilarity === undefined ||
        r.vectorSimilarity! >= options.minSimilarity,
    );
    const sort = (key: "keywordScore" | "vectorSimilarity") =>
      [...eligible].sort(
        (a, b) => (b[key] ?? -1) - (a[key] ?? -1) || a.id.localeCompare(b.id),
      );
    if (options.mode === "keyword")
      return sort("keywordScore")
        .filter((r) => r.keywordScore > 0)
        .slice(0, options.topK)
        .map((r) => ({ ...r, score: r.keywordScore }));
    if (options.mode === "vector")
      return sort("vectorSimilarity")
        .slice(0, options.topK)
        .map((r) => ({ ...r, score: r.vectorSimilarity! }));
    for (const ranking of [
      sort("keywordScore").filter((r) => r.keywordScore > 0),
      sort("vectorSimilarity"),
    ])
      ranking.forEach((row, rank) => {
        row.score += 1 / (60 + rank + 1);
      });
    return eligible
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .slice(0, options.topK);
  };
}
