export type QuickSearchResult = {
  path: string;
  title: string;
  product: string;
  version: string;
  moduleId: string;
  summary: string;
  saleItemId?: string;
  productId?: string;
  category?: string;
  score?: number;
  keywordScore?: number;
  vectorSimilarity?: number | null;
  rerankScore?: number;
};
export type QuickSearchResponse = {
  results: QuickSearchResult[];
  query: string;
  mode: string;
  elapsedMs: number;
  engine?: string;
  timings?: {
    loadMs: number;
    embeddingMs: number;
    retrievalMs: number;
    rerankMs: number;
    totalMs: number;
  };
  warnings?: string[];
  index?: { total: number; ready: number; pending: number; failed: number };
  rerank?: { enabled: boolean; applied: boolean };
};
