import { AppError } from "./errors.js";
import { wikiFilePaths } from "./wiki.js";
import type {
  WikiGraphData,
  WikiGraphNode,
  WikiGraphEdge,
} from "../shared/wiki-graph.js";

export function normalizeWikiGraph(
  result: Record<string, unknown>,
  limit: number,
): WikiGraphData {
  if (!Array.isArray(result.nodes) || !Array.isArray(result.edges))
    throw new AppError(502, "Wiki图谱响应缺少 nodes 或 edges 字段");
  const nodes: WikiGraphNode[] = [];
  const seen = new Set<string>();
  for (const value of result.nodes) {
    if (!value || typeof value !== "object") continue;
    const n = value as Record<string, unknown>;
    if (typeof n.id !== "string" || !n.id || seen.has(n.id)) continue;
    seen.add(n.id);
    nodes.push({
      id: n.id,
      label: typeof n.label === "string" ? n.label : n.id,
      path: wikiFilePaths(n.path)[0],
      nodeType: typeof n.nodeType === "string" ? n.nodeType : "other",
    });
    if (nodes.length === limit) break;
  }
  const ids = new Set(nodes.map((n) => n.id));
  const edges: WikiGraphEdge[] = [];
  const pairs = new Set<string>();
  for (const value of result.edges) {
    if (!value || typeof value !== "object") continue;
    const e = value as Record<string, unknown>;
    if (
      typeof e.source !== "string" ||
      typeof e.target !== "string" ||
      e.source === e.target ||
      !ids.has(e.source) ||
      !ids.has(e.target)
    )
      continue;
    const key = JSON.stringify([e.source, e.target].sort());
    if (pairs.has(key)) continue;
    pairs.add(key);
    edges.push({
      source: e.source,
      target: e.target,
      label: typeof e.label === "string" ? e.label : "双链关联",
    });
    if (edges.length === 600) break;
  }
  return {
    nodes,
    edges,
    truncated:
      result.truncated === true ||
      result.nodes.length >= limit ||
      result.edges.length > 600,
  };
}
