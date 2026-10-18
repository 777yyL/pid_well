import { posix } from "node:path";
import { linkedWikiPaths } from "./product-search.js";
import { parseSaleEntity } from "./sale-entity.js";
import { wikiFilePaths } from "./wiki.js";
import type {
  CapabilityGraph,
  CapabilityGraphNode,
  CapabilityRelation,
} from "../shared/capability-graph.js";

// Relationship types come only from explicit fields; a graph edge is not a dependency.
export function capabilityGraph(
  page: { id: string; path: string; content: string },
  files: string[],
  upstream?: unknown,
): CapabilityGraph {
  const nodes = new Map<string, CapabilityGraphNode>();
  const warnings: string[] = [];
  const priority = { product: 3, dependency: 2, related: 1 };
  const allowed = (p: string) =>
    p.startsWith("wiki/") &&
    !p.includes("/versions/") &&
    !p.includes("/sales/");
  const add = (node: CapabilityGraphNode) => {
    if (node.path === page.path || (node.path && !allowed(node.path))) return;
    const key = node.path || node.id;
    if (
      !nodes.has(key) ||
      priority[node.relation] > priority[nodes.get(key)!.relation]
    )
      nodes.set(key, node);
  };
  let fence = false;
  page.content.split(/\r?\n/).forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence;
      return;
    }
    if (fence) return;
    const field = line
      .replace(/^\s*[-*]\s*/, "")
      .replace(/\*\*/g, "")
      .trim();
    const relation: CapabilityRelation =
      /^(?:product\s*:|(?:所属产品|产品)\s*[:：]|\|\s*(?:所属产品|产品)\s*\|)/i.test(
        field,
      )
        ? "product"
        : /^(?:(?:dependencies|depends_on)\s*:|(?:依赖销售项|依赖项)\s*[:：]|\|\s*(?:依赖销售项|依赖项)\s*\|)/i.test(
              field,
            )
          ? "dependency"
          : "related";
    for (const m of line.matchAll(
      /\[\[([^\]#|]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]|\[([^\]]+)\]\(([^\s)]+)\)/g,
    )) {
      const link = m[1] || m[4];
      if (/^(?:[a-z][a-z\d+.-]*:|#|\/\/)/i.test(link)) continue;
      const label = m[2] || m[3] || posix.basename(link).replace(/\.md$/, "");
      let path: string | undefined;
      let unresolved: string | undefined;
      try {
        path = linkedWikiPaths(m[0], page.path, [
          ...new Set([...files, page.path]),
        ])[0];
        if (path && !files.includes(path)) {
          path = undefined;
          unresolved = "链接目标不在当前文件清单中";
        }
      } catch {
        unresolved = "链接缺失或重名，无法确定目标页面";
      }
      if (path === page.path) continue;
      // Do not reintroduce deleted version/category pages as graph candidates.
      if (/-(?:v\d+\.\d+)/i.test(link) && !path) continue;
      add({
        id: path || link,
        label,
        path,
        relation,
        source: "page",
        quote: line.trim(),
        line: index + 1,
        unresolved: unresolved || (!path ? "链接无法定位" : undefined),
      });
    }
  });
  const entity = parseSaleEntity(page.content);
  if (
    entity.product &&
    ![...nodes.values()].some((n) => n.relation === "product")
  ) {
    const matches = files.filter(
      (p) =>
        allowed(p) &&
        posix.basename(p, ".md").toLowerCase() === entity.product.toLowerCase(),
    );
    const lines = page.content.split(/\r?\n/);
    const line = lines.findIndex((l) =>
      /^(?:product\s*:|\s*\|\s*(?:所属产品|产品)\s*\||\s*[-*]\s*(?:所属产品|产品)\s*[:：]|>\s*产品\s)/i.test(
        l,
      ),
    );
    if (line >= 0)
      add({
        id: matches.length === 1 ? matches[0] : `product:${entity.product}`,
        label: entity.product,
        path: matches.length === 1 ? matches[0] : undefined,
        relation: "product",
        source: "page",
        quote: lines[line],
        line: line + 1,
        unresolved:
          matches.length === 1
            ? undefined
            : "产品名称无法唯一定位页面，请查看产品原文链接",
      });
  }
  const graph = upstream as
    | {
        nodes?: { id?: string; path?: string; label?: string }[];
        edges?: { source?: string; target?: string }[];
      }
    | undefined;
  if (Array.isArray(graph?.nodes) && Array.isArray(graph.edges)) {
    const roots = graph.nodes
      .filter(
        (n) =>
          typeof n.id === "string" && wikiFilePaths(n.path).includes(page.path),
      )
      .map((n) => n.id);
    for (const edge of graph.edges) {
      const other = roots.includes(edge.source)
        ? edge.target
        : roots.includes(edge.target)
          ? edge.source
          : undefined;
      const node = graph.nodes.find((n) => n.id === other);
      const path = node && wikiFilePaths(node.path)[0];
      if (!other || !path || !files.includes(path)) continue;
      add({
        id: path,
        label: node!.label || posix.basename(path, ".md"),
        path,
        relation: "related",
        source: "graph",
        quote: "LLM Wiki 图谱直接关联边；不代表依赖、兼容或交付承诺。",
      });
    }
  }
  const all = [...nodes.values()].sort(
    (a, b) => priority[b.relation] - priority[a.relation],
  );
  if (all.length > 12)
    warnings.push(
      `共发现${all.length}个一层关联，当前展示前12个；完整链接请查看原文。`,
    );
  return {
    root: {
      label:
        parseSaleEntity(page.content).title || posix.basename(page.path, ".md"),
      path: page.path,
      pageId: page.id,
    },
    nodes: all.slice(0, 12),
    warnings,
  };
}
