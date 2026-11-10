import type { KnowledgeRelease } from "../shared/product-knowledge.js";
import type { WikiGraphData } from "../shared/wiki-graph.js";
import { knowledgePath } from "./structured-knowledge.js";

export function knowledgeGraph(
  source: KnowledgeRelease,
  query: string,
  limit: number,
): WikiGraphData {
  const nodes: WikiGraphData["nodes"] = [],
    edges: WikiGraphData["edges"] = [];
  for (const p of source.data.products)
    nodes.push({
      id: "p:" + p.product_id,
      label: p.product_code,
      path: knowledgePath(source.id, "products", p.product_id),
      nodeType: "product",
    });
  for (const s of source.data.saleItems) {
    nodes.push({
      id: "s:" + s.sale_item_id,
      label: s.name,
      path: knowledgePath(source.id, "sale-items", s.sale_item_id),
      nodeType: "sale-item",
    });
    const v = source.data.versions.find(
      (v) => v.product_version_id === s.product_version_id,
    )!;
    edges.push({
      source: "p:" + v.product_id,
      target: "s:" + s.sale_item_id,
      label: "包含 · " + v.version,
    });
  }
  for (const d of source.data.dependencies)
    edges.push({
      source: "s:" + d.sale_item_id,
      target: "s:" + d.depends_on_sale_item_id,
      label:
        d.dependency_type === "required"
          ? "必选依赖"
          : d.dependency_type === "conditional"
            ? "条件依赖"
            : "可选依赖",
    });
  const q = query.trim().toLowerCase();
  const roots = nodes.filter(
    (n) =>
      !q ||
      n.label.toLowerCase().includes(q) ||
      n.path?.toLowerCase() === q ||
      n.id.toLowerCase() === q,
  );
  const ids = new Set(roots.map((n) => n.id));
  for (const e of edges)
    if (roots.some((n) => n.id === e.source || n.id === e.target)) {
      ids.add(e.source);
      ids.add(e.target);
    }
  const ordered = [
    ...roots,
    ...nodes.filter((n) => ids.has(n.id) && !roots.some((r) => r.id === n.id)),
  ];
  const selected = ordered.slice(0, limit),
    allowed = new Set(selected.map((n) => n.id));
  return {
    nodes: selected,
    edges: edges.filter((e) => allowed.has(e.source) && allowed.has(e.target)),
    truncated: ordered.length > limit,
  };
}
