export type QuickSearchResult = {
  path: string;
  title: string;
  product: string;
  version: string;
  moduleId: string;
  summary: string;
};
export type QuickSearchResponse = {
  results: QuickSearchResult[];
  query: string;
  mode: string;
  elapsedMs: number;
};
