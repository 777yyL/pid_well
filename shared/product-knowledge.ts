export interface KnowledgeProduct {
  product_id: string;
  product_code: string;
  name: string;
  product_line: string | null;
  department: string | null;
  owner: string | null;
  summary: string | null;
  scenarios: string | null;
  boundaries: string | null;
  source_path: string | null;
  status: string;
}
export interface KnowledgeVersion {
  product_version_id: string;
  product_id: string;
  version: string;
  status: string;
  effective_date: string | null;
  source_path: string | null;
}
export interface KnowledgeCategory {
  category_id: string;
  product_version_id: string;
  name: string;
  sort_order: number;
}
export interface KnowledgeSale {
  sale_item_id: string;
  product_version_id: string;
  category_id: string | null;
  module_code: string | null;
  name: string;
  description: string | null;
  specification_md: string | null;
  unit: string | null;
  price_type: string;
  fixed_price: string | number | null;
  currency: string | null;
  pricing_note: string | null;
  mandatory: boolean | null;
  authorization_note: string | null;
  prerequisites: string | null;
  limitations: string | null;
  dependency_note: string | null;
  source_path: string | null;
  source_file: string | null;
  source_sheet: string | null;
  source_row: number | null;
  status: string;
}
export interface KnowledgeDependency {
  dependency_id: string;
  sale_item_id: string;
  depends_on_sale_item_id: string;
  dependency_type: string;
  condition_note: string | null;
  source_note: string;
}
export interface KnowledgeData {
  products: KnowledgeProduct[];
  versions: KnowledgeVersion[];
  categories: KnowledgeCategory[];
  saleItems: KnowledgeSale[];
  dependencies: KnowledgeDependency[];
}
export interface KnowledgeRelease {
  id: string;
  wiki_project_id: string;
  name: string;
  created_at: string;
  data: KnowledgeData;
}
export interface KnowledgeBrowse {
  releaseId: string | null;
  releaseName?: string;
  product?: KnowledgeProduct;
  version?: KnowledgeVersion;
  versions: KnowledgeVersion[];
  categories: (KnowledgeCategory & { count: number })[];
  items: Omit<KnowledgeSale, "specification_md">[];
  total: number;
  offset: number;
  limit: number;
}
