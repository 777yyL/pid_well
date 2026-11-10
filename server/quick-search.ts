import { liveKnowledge } from './product-knowledge.js';
import { knowledgeContent } from './structured-knowledge.js';
import { knowledgeSearchSchema, searchKnowledge } from './knowledge-search.js';
import { knowledgeGraph } from './knowledge-graph.js';
import type { FastifyInstance } from "fastify";
import type { Database } from "./db.js";
import { z } from "zod";
import { requireUser } from "./auth.js";
import { WikiClient, wikiFilePaths } from "./wiki.js";
import { parseSaleEntity } from "./sale-entity.js";
import { AppError } from "./errors.js";
import type { QuickSearchResult } from "../shared/quick-search.js";
import { normalizeWikiGraph } from "./wiki-graph.js";

export function quickSearchResults(
  response: Record<string, unknown>,
): QuickSearchResult[] {
  if (!Array.isArray(response.results)) throw new AppError(502, "知识库搜索响应缺少 results 字段，请检查接口版本");
  const results: QuickSearchResult[] = [];
  const seen = new Set<string>();
  const items = Array.isArray(response.results) ? response.results : [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const hit = item as Record<string, unknown>;
    const path = wikiFilePaths(hit.path ?? hit.filePath ?? hit.file_path)[0];
    if (!path || seen.has(path)) continue;
    const content = typeof hit.content === "string" ? hit.content : "";
    let entity;
    try {
      entity = parseSaleEntity(content);
    } catch {
      continue;
    }
    const canonical = path.startsWith("wiki/entities/sale-items/");
    if (
      !canonical &&
      !(/^wiki\/entities\/[^/]+\.md$/.test(path) && entity.moduleId)
    )
      continue;
    seen.add(path);
    results.push({
      path,
      title:
        entity.title ||
        (typeof hit.title === "string" ? hit.title : path.split("/").at(-1)!),
      product: entity.product,
      version: entity.version,
      moduleId: entity.moduleId,
      summary: (
        entity.description ||
        (typeof hit.snippet === "string" ? hit.snippet : "")
      ).slice(0, 800),
    });
  }
  return results;
}

export function quickSearchRoutes(app: FastifyInstance, db: Database) {
  app.post('/api/capability/search', {config:{rateLimit:{max:60,timeWindow:'1 minute'}}},async request => {
    requireUser(request);
    return searchKnowledge(db,knowledgeSearchSchema.parse(request.body));
  });
  app.post('/api/capability/source',async request => {
    requireUser(request);
    const input = z.object({path:z.string().min(1).max(2000)}).parse(request.body);
    const content = knowledgeContent(await liveKnowledge(db),input.path);
    if (content === undefined) throw new AppError(404,'PG 中不存在该产品或销售项');
    return {path:input.path,content};
  });
  app.post('/api/capability/graph',async request => {
    requireUser(request);
    const input = z.object({query:z.string().max(2000).default(''),limit:z.number().int().min(1).max(80).default(60)}).parse(request.body);
    return knowledgeGraph(await liveKnowledge(db),input.query,input.limit);
  });
}
