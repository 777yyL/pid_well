import type { KnowledgeRelease } from "../shared/product-knowledge.js";
import { saleMarkdown } from "./structured-knowledge.js";

export function knowledgeDocuments(
  source: KnowledgeRelease,
  sales = source.data.saleItems,
) {
  const products = new Map(source.data.products.map((p) => [p.product_id, p]));
  const versions = new Map(
    source.data.versions.map((v) => [v.product_version_id, v]),
  );
  const categories = new Map(
    source.data.categories.map((c) => [c.category_id, c]),
  );
  const dependencies = new Map<string, typeof source.data.dependencies>();
  for (const dependency of source.data.dependencies) {
    const list = dependencies.get(dependency.sale_item_id) ?? [];
    list.push(dependency);
    dependencies.set(dependency.sale_item_id, list);
  }
  return sales.map((sale) => {
    const version = versions.get(sale.product_version_id)!;
    const product = products.get(version.product_id)!;
    const category = categories.get(sale.category_id ?? "");
    const related = dependencies.get(sale.sale_item_id) ?? [];
    // Format evidence once during indexing, using only this record's relations.
    const focused = {
      ...source,
      data: {
        ...source.data,
        products: [product],
        versions: [version],
        categories: category ? [category] : [],
        dependencies: related,
      },
    };
    const searchText = [
      sale.name,
      product.product_code,
      version.version,
      category?.name,
      sale.module_code,
      sale.description,
      sale.specification_md,
      sale.authorization_note,
      sale.prerequisites,
      sale.limitations,
      sale.dependency_note,
      ...related.map((d) => d.source_note),
    ]
      .filter(Boolean)
      .join("\n")
      .replace(/<br\s*\/?\s*>/gi, "\n");
    return {
      id: sale.sale_item_id,
      title: sale.name,
      productId: product.product_id,
      versionId: version.product_version_id,
      categoryId: sale.category_id,
      text: saleMarkdown(focused, sale),
      searchText,
      sale,
      product,
      version,
      category: category?.name ?? "未分类",
    };
  });
}
