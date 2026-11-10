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
};
export type QuickSearchResponse = {
  results: QuickSearchResult[];
  query: string;
  mode: string;
  elapsedMs: number;
};
