import { posix } from "node:path";
import { z } from "zod";
import { parse as parseYaml } from "yaml";
import type { Database } from "./db.js";
import { audit } from "./db.js";
import { AppError } from "./errors.js";
import {
  WikiClient,
  snapshotPage,
  wikiFilePaths,
  PRODUCT_OVERVIEW_PATH,
} from "./wiki.js";
import { parseSaleEntity } from "./sale-entity.js";
import { retrievalTokens } from "../shared/retrieval.js";
import {
  projectKnowledge,
  materializeProduct,
  knowledgeChoice,
  knowledgePath,
  knowledgeContent,
  saleMarkdown,
} from "./structured-knowledge.js";
import { productScope } from "./product-scope.js";
import {
  productChoiceSchema,
  evidenceSchema,
  type ProductScope,
} from "../shared/domain.js";

type Choice = ProductScope["selected"][number];
type Page = { id: string; path: string; content: string };
type Catalog = {
  parserVersion?: number;
  scopeRevision: number;
  products: {
    choice: Choice;
    root: Pick<Page, "id" | "path">;
    paths: string[];
  }[];
};
export const sameVersion = (a: string, b: string) =>
  a.replace(/^v/i, "").trim() === b.replace(/^v/i, "").trim();
const aliases = (p: Choice) =>
  [p.name, posix.basename(p.path, ".md")].filter(Boolean);
const identity = (value: string) => value.toLowerCase().replace(/[\s_-]/g, "");
export async function resolveProductPage(
  db: Database,
  projectId: string,
  choice: Choice,
) {
  const release = await projectKnowledge(db, projectId);
  if (release) return materializeProduct(db, projectId, release, choice);
  const pages = await db.query<Page>(
    "SELECT DISTINCT ON(path) id,path,content FROM snapshots WHERE project_id=$1 AND kind='product'  ORDER BY path,created_at DESC",
    [projectId],
  );
  const matches = pages.filter((page) => {
    if (choice.path && choice.path.includes("/products/"))
      return page.path === choice.path;
    const entity = parseSaleEntity(page.content);
    const clean = page.content.replace(/\*\*|`/g, "");
    const front = clean.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    const metadata = front ? (parseYaml(front[1]) ?? {}) : {};
    const labelled = [...clean.matchAll(/产品标识\s*[:：|]\s*([^\n|·]+)/g)].map(
      (m) => m[1].trim(),
    );
    return [
      entity.title,
      entity.product,
      String(metadata.product_id ?? metadata.productId ?? ""),
      posix.basename(page.path, ".md"),
      ...labelled,
    ].some((value) => value && identity(value) === identity(choice.name));
  });
  if (matches.length > 1)
    throw new AppError(
      422,
      `产品「${choice.name}」存在多个产品档案，请选择准确产品页路径`,
    );
  return matches[0];
}

export function productVersionList(content: string, version: string) {
  const lines = content.split(/\r?\n/);
  const headings = lines.flatMap((line, index) => {
    const match = line.match(/^(#{2,6})\s+(v?\d+(?:\.\d+)*)(?=[\s（(]|$)/i);
    return match ? [{ index, level: match[1].length, version: match[2] }] : [];
  });
  const selected = headings.filter((h) => sameVersion(h.version, version));
  if (selected.length > 1)
    throw new AppError(422, "产品页所选版本销售项清单重复，请核实");
  if (selected.length === 1) {
    const start = selected[0];
    let end = start.index + 1;
    while (end < lines.length) {
      const heading = lines[end].match(/^(#{1,6})\s/);
      if (heading && heading[1].length <= start.level) break;
      end++;
    }
    return lines.slice(start.index + 1, end).join("\n");
  }
  const metaVersion = parseSaleEntity(content).version;
  if (!headings.length && metaVersion && sameVersion(metaVersion, version))
    return content;
  throw new AppError(
    422,
    "产品页缺少所选版本的销售项清单，请补充产品页；不再读取版本页或分类页",
  );
}
export function linkedWikiPaths(
  content: string,
  root: string,
  knownPaths: string[] = [],
) {
  const links = [...content.matchAll(/\[\[([^\]#|]+)(?:[#|][^\]]*)?\]\]/g)].map(
    (m) => ({ value: m[1], bare: true }),
  );
  links.push(
    ...[...content.matchAll(/\[[^\]]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)].map(
      (m) => ({ value: m[1], bare: false }),
    ),
  );
  return [
    ...new Set(
      links.flatMap(({ value: link, bare }) => {
        if (/^(?:https?:|#|\/\/)/i.test(link)) return [];
        let clean: string;
        try {
          clean = decodeURIComponent(link.split("#")[0]);
        } catch {
          return [];
        }
        if (!clean || clean.includes("\\") || /[?]/.test(clean)) return [];
        if (!clean.endsWith(".md")) clean += ".md";
        if (bare && !clean.includes("/")) {
          const matches = [
            ...new Set(knownPaths.filter((p) => posix.basename(p) === clean)),
          ];
          if (matches.length !== 1)
            throw new AppError(
              422,
              matches.length
                ? `知识库链接重名：${clean}，请使用完整路径`
                : `知识库链接未找到：${clean}，请核实文件清单`,
            );
          return matches[0] === root ? [] : matches;
        }
        const path = posix.normalize(
          clean.startsWith("wiki/")
            ? clean
            : posix.join(posix.dirname(root), clean),
        );
        return path.startsWith("wiki/") && path !== root ? [path] : [];
      }),
    ),
  ];
}
function belongs(page: Page, choice: Choice) {
  const sale = parseSaleEntity(page.content);
  if (!sale.title || (!sale.moduleId && !page.path.includes("/sale-items/")))
    return false;
  if (sale.product && !aliases(choice).includes(sale.product)) return false;
  if (
    choice.version &&
    sale.version &&
    !sameVersion(choice.version, sale.version)
  )
    return false;
  return true;
}
async function boundWiki(
  db: Database,
  projectId: string,
  signal?: AbortSignal,
) {
  const [p] = await db.query<{ wiki_project_id: string }>(
    "SELECT wiki_project_id FROM projects WHERE id=$1",
    [projectId],
  );
  if (!p) throw new AppError(404, "项目不存在");
  return { wiki: new WikiClient(db, signal), wikiId: p.wiki_project_id };
}
async function requireClause(db: Database, projectId: string, id: string) {
  const [row] = await db.query(
    "SELECT id FROM requirements WHERE project_id=$1 AND id=$2 AND confirmed=true",
    [projectId, id],
  );
  if (!row) throw new AppError(409, "检索必须关联本项目已确认的条款编号");
}
export async function selectedCatalog(
  db: Database,
  projectId: string,
  runId: string,
  signal?: AbortSignal,
): Promise<Catalog> {
  const scope = await productScope(db, projectId);
  if (scope.status !== "confirmed" || !scope.selected.length)
    throw new AppError(409, "请先确认产品与版本，再建立销售项目录");
  const release = await projectKnowledge(db, projectId);
  if (release) {
    const products = [];
    for (const choice of scope.selected) {
      const { product, version } = knowledgeChoice(release, choice);
      const root = await materializeProduct(db, projectId, release, choice);
      products.push({
        choice: { ...choice, path: root.path },
        root: { id: root.id, path: root.path },
        paths: release.data.saleItems
          .filter((s) => s.product_version_id === version.product_version_id)
          .map((s) => knowledgePath(release.id, "sale-items", s.sale_item_id)),
      });
    }
    return { parserVersion: 4, scopeRevision: scope.revision, products };
  }
  const [cached] = await db.query<{ data: Catalog }>(
    "SELECT data FROM audit_log WHERE project_id=$1 AND action='product_catalog' AND (data->>'scopeRevision')::int=$2 ORDER BY id DESC LIMIT 1",
    [projectId, scope.revision],
  );
  if (cached?.data.parserVersion === 4) return cached.data;
  const { wiki, wikiId } = await boundWiki(db, projectId, signal);
  let filePaths: string[] | undefined;
  const links = async (page: Page) => {
    if (
      /\[\[[^\]/#|]+(?:[#|][^\]]*)?\]\]/.test(page.content) ||
      /\]\([^/)\s]+\)/.test(page.content)
    )
      filePaths ??= await wiki.files(wikiId);
    const snapshots = await db.query<{ path: string }>(
      "SELECT DISTINCT path FROM snapshots WHERE project_id=$1",
      [projectId],
    );
    return linkedWikiPaths(page.content, page.path, [
      ...new Set([...(filePaths ?? []), ...snapshots.map((p) => p.path)]),
    ]);
  };
  const products: Catalog["products"] = [];
  for (const selected of scope.selected) {
    signal?.throwIfAborted();
    let path = selected.path;
    const knownProduct = await resolveProductPage(db, projectId, selected);
    if (!path || path.includes("/versions/")) path = knownProduct?.path ?? "";
    if (!path)
      throw new AppError(
        422,
        `产品「${selected.name}」缺少准确产品页路径，请先读取产品页或补充路径，不能直接全局匹配`,
      );
    const content = await wiki.read(wikiId, path);
    const root = await snapshotPage(db, projectId, path, content);
    const meta = parseSaleEntity(content);
    if (root.kind !== "product" || meta.moduleId)
      throw new AppError(422, "选定路径是销售项而非产品目录，请修正产品页路径");
    const choice = { ...selected, path };
    const list = productVersionList(root.content, choice.version);
    const paths = (await links({ ...root, content: list })).filter((p) =>
      p.includes("/sale-items/"),
    );
    products.push({
      choice,
      root: { id: root.id, path: root.path },
      paths: [...new Set(paths)],
    });
  }
  const result = { parserVersion: 4, scopeRevision: scope.revision, products };
  await audit(db, projectId, null, runId, "product_catalog", result);
  return result;
}
export async function readCatalogPage(
  db: Database,
  projectId: string,
  runId: string,
  offset: number,
  count: number,
  signal?: AbortSignal,
  onProgress?: (data: Record<string, unknown>) => Promise<void>,
) {
  const catalog = await selectedCatalog(db, projectId, runId, signal);
  const paths = [...new Set(catalog.products.flatMap((p) => p.paths))];
  const { wiki, wikiId } = await boundWiki(db, projectId, signal);
  const items = [];
  const release = await projectKnowledge(db, projectId);
  let loaded = offset;
  for (const path of paths.slice(offset, offset + count)) {
    signal?.throwIfAborted();
    const [cached] = await db.query<Page>(
      "SELECT id,path,content FROM snapshots WHERE project_id=$1 AND path=$2 ORDER BY created_at DESC LIMIT 1",
      [projectId, path],
    );
    const page =
      cached ??
      (await snapshotPage(
        db,
        projectId,
        path,
        (release ? knowledgeContent(release, path) : undefined) ??
          (await wiki.read(wikiId, path)),
      ));
    const owners = catalog.products.filter(
      (p) => p.paths.includes(path) && belongs(page, p.choice),
    );
    if (owners.length) {
      const entity = parseSaleEntity(page.content);
      items.push({
        path,
        snapshotId: page.id,
        title: entity.title,
        products: owners.map((p) => p.choice),
        moduleId: entity.moduleId,
      });
    }
    await onProgress?.({ path, loaded: ++loaded, total: paths.length });
    await audit(db, projectId, null, runId, "catalog_page_read", {
      scopeRevision: catalog.scopeRevision,
      path,
      snapshotId: page.id,
      sale: !!owners.length,
    });
  }
  const seen = await db.query<{ path: string }>(
    "SELECT DISTINCT data->>'path' AS path FROM audit_log WHERE project_id=$1 AND action='catalog_page_read' AND (data->>'scopeRevision')::int=$2",
    [projectId, catalog.scopeRevision],
  );
  const done = new Set(seen.map((p) => p.path));
  const missing = paths.filter((p) => !done.has(p));
  return {
    scopeRevision: catalog.scopeRevision,
    products: catalog.products.map((p) => ({
      product: p.choice.name,
      version: p.choice.version,
      rootSnapshotId: p.root.id,
      path: p.choice.path,
      directoryPath: p.root.path,
      catalogLinks: p.paths.length,
    })),
    items,
    total: paths.length,
    remaining: missing.length,
    nextOffset: offset + count,
    complete: !missing.length,
    note: !paths.length
      ? "产品页未列出销售项链接，目录证据不足；可针对已确认条款记录原因后全局补查，不得推断产品无能力"
      : undefined,
  };
}
export interface SelectedSearchContext {
  projectId: string;
  runId: string;
  catalog: Catalog;
  release: Awaited<ReturnType<typeof projectKnowledge>>;
  paths: string[];
}
export async function prepareSelectedSearch(
  db: Database,
  projectId: string,
  runId: string,
  signal?: AbortSignal,
): Promise<SelectedSearchContext> {
  const catalog = await selectedCatalog(db, projectId, runId, signal);
  return {
    projectId,
    runId,
    catalog,
    release: await projectKnowledge(db, projectId),
    paths: [...new Set(catalog.products.flatMap((p) => p.paths))],
  };
}
export async function searchSelected(
  db: Database,
  projectId: string,
  runId: string,
  requirementId: string,
  query: string,
  topK: number,
  signal?: AbortSignal,
  subrequirementId?: string,
  recallCache = new Map<string, Promise<Record<string, unknown>>>(),
  prepared?: SelectedSearchContext,
) {
  const started = Date.now();
  await requireClause(db, projectId, requirementId);
  if (prepared) {
    if (prepared.projectId !== projectId || prepared.runId !== runId)
      throw new AppError(409, "检索上下文不属于当前任务");
    const [live] = await db.query<{ revision: number; status: string }>(
      "SELECT revision,status FROM product_scopes WHERE project_id=$1",
      [projectId],
    );
    if (
      !live ||
      live.status !== "confirmed" ||
      live.revision !== prepared.catalog.scopeRevision
    )
      throw new AppError(409, "产品范围已变化，请重新开始初评");
  }
  const { catalog, paths, release } =
    prepared ?? (await prepareSelectedSearch(db, projectId, runId, signal));
  if (release)
    return searchStructured(
      db,
      projectId,
      runId,
      release,
      catalog,
      requirementId,
      query,
      topK,
      subrequirementId,
      undefined,
      signal,
      recallCache,
    );
  const { wiki, wikiId } = await boundWiki(db, projectId, signal);
  // Search only nominates candidates. Full pages below provide the evidence;
  // membership and version checks still use the selected product directory.
  const recallLimit = Math.min(50, Math.max(5, topK * 2));
  const cacheKey = JSON.stringify([
    wikiId,
    catalog.scopeRevision,
    [...paths].sort(),
    query,
    recallLimit,
  ]);
  let recall = recallCache.get(cacheKey);
  if (!recall) {
    recall = wiki.search(wikiId, query, recallLimit, false, paths);
    recallCache.set(cacheKey, recall);
  }
  const response = await recall;
  if (!Array.isArray(response.results))
    throw new AppError(502, "知识库搜索响应缺少 results 字段，不能视为未命中");
  const responseResults = response.results;
  const allowed = new Set(paths);
  const recalledPaths = [
    ...new Set(
      response.results.flatMap((hit: unknown) => {
        if (!hit || typeof hit !== "object") return [];
        const h = hit as Record<string, unknown>;
        return wikiFilePaths(h.path ?? h.filePath ?? h.file_path);
      }),
    ),
  ];
  if (response.results.length && !recalledPaths.length)
    throw new AppError(502, "知识库搜索结果缺少可识别路径，不能视为未命中");
  const recalledCandidates = recalledPaths.filter((p) => allowed.has(p));
  const candidates: string[] = [];
  const pages = await db.query<Page>(
    "SELECT DISTINCT ON(path) id,path,content FROM snapshots WHERE project_id=$1 ORDER BY path,created_at DESC",
    [projectId],
  );
  const cachedPages = new Map(pages.map((page) => [page.path, page]));
  let entityReads = 0;
  for (const path of recalledCandidates) {
    signal?.throwIfAborted();
    let page = cachedPages.get(path);
    if (!page) {
      entityReads++;
      page = await snapshotPage(
        db,
        projectId,
        path,
        await wiki.read(wikiId, path),
      );
      pages.push(page);
      cachedPages.set(path, page);
    }
    if (
      !catalog.products.some(
        (p) => p.paths.includes(path) && belongs(page, p.choice),
      )
    )
      continue;
    candidates.push(path);
    if (candidates.length >= Math.min(20, Math.max(5, topK * 2))) break;
  }
  const tokens = retrievalTokens(query);
  const hits = candidates.map((path) => {
    const page = cachedPages.get(path)!;
    const entity = parseSaleEntity(page.content);
    const hit = responseResults.find((value: unknown) => {
      const row = value as Record<string, unknown>;
      return wikiFilePaths(row.path ?? row.filePath ?? row.file_path).includes(
        path,
      );
    }) as Record<string, unknown> | undefined;
    return {
      path,
      snapshotId: page.id,
      sales: entity.title,
      products: catalog.products
        .filter((p) => p.paths.includes(path) && belongs(page, p.choice))
        .map((p) => p.choice),
      score: typeof hit?.score === "number" ? hit.score : 0,
      moduleId: entity.moduleId,
      pageContent: page.content,
    };
  });
  const traceId = await audit(
    db,
    projectId,
    null,
    runId,
    "product_scoped_search",
    {
      scopeRevision: catalog.scopeRevision,
      requirementId,
      subrequirementId,
      query,
      matchCount: hits.length,
      paths: hits.slice(0, topK).map((h) => h.path),
      directoryEmpty: !paths.length,
      elapsedMs: Date.now() - started,
      recallLimit,
      candidates: candidates.length,
      entityReads,
    },
  );
  return {
    stage: "selected_product",
    traceId,
    subrequirementId,
    requirementId,
    scopeRevision: catalog.scopeRevision,
    total: hits.length,
    results: hits.slice(0, topK).map(({ pageContent, ...hit }) => ({
      ...hit,
      ...evidenceExcerpts(pageContent, tokens),
    })),
    elapsedMs: Date.now() - started,
    recallComplete: false,
    note: "已按产品页目录及版本过滤，excerpts 来自实体快照，可直接引用；片段不足再 wiki_read。召回有数量限制，未命中不证明不支持，应换关键词或记录原因补查。分数仅表示相关性。",
  };
}
async function searchStructured(
  db: Database,
  projectId: string,
  runId: string,
  release: import("../shared/product-knowledge.js").KnowledgeRelease,
  catalog: Catalog,
  requirementId: string,
  query: string,
  topK: number,
  subrequirementId?: string,
  fallback?: { reason: string; explanation: string },
  signal?: AbortSignal,
  recallCache = new Map<string, Promise<Record<string, unknown>>>(),
) {
  const started = Date.now(),
    tokens = retrievalTokens(query);
  const allowed = new Set(catalog.products.flatMap((p) => p.paths));
  const keywordRank = () =>
    release.data.saleItems
      .flatMap((s) => {
        const path = knowledgePath(release.id, "sale-items", s.sale_item_id);
        if (!allowed.has(path)) return [];
        const text = [
          s.name,
          s.module_code,
          s.description,
          s.specification_md,
          s.prerequisites,
          s.limitations,
        ]
          .join(" ")
          .toLowerCase();
        const score = tokens.reduce(
          (n, t) =>
            n +
            (text.includes(t)
              ? t.length * (s.name.toLowerCase().includes(t) ? 4 : 1)
              : 0),
          0,
        );
        return score ? [{ sale: s, path, score }] : [];
      })
      .sort((a, b) => b.score - a.score);
  const scopedSales = release.data.saleItems.filter((sale) =>
    allowed.has(knowledgePath(release.id, "sale-items", sale.sale_item_id)),
  );
  const sources = new Map<string, typeof scopedSales>();
  for (const sale of scopedSales) {
    const paths = wikiFilePaths(sale.source_path);
    if (paths.length !== 1 || paths[0].startsWith("wiki/structured/")) continue;
    sources.set(paths[0], [...(sources.get(paths[0]) ?? []), sale]);
  }
  let mode = "structured_keyword";
  let ranked: ReturnType<typeof keywordRank> = [];
  let retrievalNote = "没有可用 source_path，使用固定发布数据关键词召回。";
  if (sources.size) {
    const { wiki, wikiId } = await boundWiki(db, projectId, signal);
    const sourcePaths = [...sources.keys()].sort();
    const cacheKey = JSON.stringify([
      wikiId,
      release.id,
      sourcePaths,
      query,
      topK,
    ]);
    let recall = recallCache.get(cacheKey);
    if (!recall) {
      recall = wiki.search(wikiId, query, topK, false, sourcePaths);
      recallCache.set(cacheKey, recall);
    }
    const response = await recall;
    if (!Array.isArray(response.results))
      throw new AppError(502, "知识库搜索响应缺少 results 字段");
    ranked = response.results.flatMap((value: unknown) => {
      const hit = value as Record<string, unknown>;
      const paths = wikiFilePaths(hit.path ?? hit.filePath ?? hit.file_path);
      if (paths.length !== 1)
        throw new AppError(502, "知识库搜索结果缺少可识别路径");
      const sales = sources.get(paths[0]);
      if (!sales) throw new AppError(502, "知识库返回范围外搜索结果");
      return sales.map((sale) => ({
        sale,
        path: knowledgePath(release.id, "sale-items", sale.sale_item_id),
        score: typeof hit.score === "number" ? hit.score : 0,
      }));
    });
    mode = "structured_wiki_scoped";
    retrievalNote = `Wiki 范围召回；证据仅使用固定发布数据。${scopedSales.length - [...sources.values()].flat().length} 项缺少可用 source_path；共享来源的销售项分别保留发布版本身份。`;
  } else ranked = keywordRank();
  const results = [];
  for (const hit of ranked.slice(0, topK)) {
    const page = await snapshotPage(
      db,
      projectId,
      hit.path,
      saleMarkdown(release, hit.sale),
    );
    results.push({
      path: page.path,
      snapshotId: page.id,
      sales: hit.sale.name,
      moduleId: hit.sale.module_code,
      saleItemId: hit.sale.sale_item_id,
      knowledgeReleaseId: release.id,
      score: hit.score,
      products: catalog.products
        .filter((p) => p.paths.includes(page.path))
        .map((p) => p.choice),
      ...evidenceExcerpts(page.content, tokens),
    });
  }
  const traceId = await audit(
    db,
    projectId,
    null,
    runId,
    fallback ? "product_global_search" : "product_scoped_search",
    {
      scopeRevision: catalog.scopeRevision,
      knowledgeReleaseId: release.id,
      requirementId,
      subrequirementId,
      query,
      matchCount: ranked.length,
      paths: results.map((r) => r.path),
      elapsedMs: Date.now() - started,
      mode,
      ...fallback,
    },
  );
  return {
    stage: fallback ? "global_fallback" : "selected_product",
    traceId,
    requirementId,
    subrequirementId,
    scopeRevision: catalog.scopeRevision,
    total: ranked.length,
    results,
    mode,
    knowledgeReleaseId: release.id,
    elapsedMs: Date.now() - started,
    note:
      retrievalNote +
      " 召回不是满足性结论；补查仅作替代建议。片段为发布数据固定渲染，可按行号引用。",
  };
}

function evidenceExcerpts(content: string, tokens: string[]) {
  const lines = content.split(/\r?\n/);
  const ranges: {
    lineStart: number;
    lineEnd: number;
    quote: string;
    truncated: boolean;
  }[] = [];
  const matches = lines.flatMap((line, i) =>
    tokens.some((t) => line.toLowerCase().includes(t)) ? [i] : [],
  );
  for (const index of matches.length ? matches : [0]) {
    if (ranges.some((r) => index + 1 >= r.lineStart && index + 1 <= r.lineEnd))
      continue;
    const start = Math.max(0, index - 2),
      end = Math.min(lines.length, index + 7);
    const quote = lines.slice(start, end).join("\n");
    ranges.push({
      lineStart: start + 1,
      lineEnd: end,
      quote: quote.slice(0, 1200),
      truncated: quote.length > 1200,
    });
    if (ranges.length === 3) break;
  }
  return { totalLines: lines.length, excerpts: ranges };
}

export async function searchSelectedBatch(
  db: Database,
  projectId: string,
  runId: string,
  queries: {
    requirementId: string;
    subrequirementId?: string;
    query: string;
    topK: number;
  }[],
  signal?: AbortSignal,
) {
  const started = Date.now();
  const recallCache = new Map<string, Promise<Record<string, unknown>>>();
  const results = [];
  for (const input of queries) {
    signal?.throwIfAborted();
    try {
      results.push({
        ...input,
        result: await searchSelected(
          db,
          projectId,
          runId,
          input.requirementId,
          input.query,
          input.topK,
          signal,
          input.subrequirementId,
          recallCache,
        ),
      });
    } catch (error) {
      signal?.throwIfAborted();
      results.push({
        ...input,
        error: error instanceof Error ? error.message : "检索失败",
        retryRequired: true,
      });
    }
  }
  return {
    results,
    elapsedMs: Date.now() - started,
    note: "逐条结果保留独立 traceId，失败项没有未命中结论；按条款分别核实，不得将同批证据自动套用。",
  };
}

export async function searchGlobalFallback(
  db: Database,
  projectId: string,
  runId: string,
  input: {
    requirementId: string;
    query: string;
    topK: number;
    reason: "no_match" | "insufficient_evidence";
    explanation: string;
  },
  signal?: AbortSignal,
) {
  await requireClause(db, projectId, input.requirementId);
  const scope = await productScope(db, projectId);
  if (scope.status !== "confirmed")
    throw new AppError(409, "全局补查前必须确认产品范围");
  const [trace] = await db.query<{ data: { matchCount: number } }>(
    "SELECT data FROM audit_log WHERE project_id=$1 AND action='product_scoped_search' AND data->>'requirementId'=$2 AND (data->>'scopeRevision')::int=$3 ORDER BY id DESC LIMIT 1",
    [projectId, input.requirementId, scope.revision],
  );
  if (!trace) throw new AppError(409, "该条款尚未完成产品内检索，禁止全局补查");
  if (input.reason === "no_match" && trace.data.matchCount)
    throw new AppError(
      422,
      "产品内已有候选，应先核实候选；证据不足时明确记录不足原因",
    );
  const release = await projectKnowledge(db, projectId);
  if (release) {
    const products = release.data.versions.map((v) => {
      const p = release.data.products.find(
        (p) => p.product_id === v.product_id,
      )!;
      const path = knowledgePath(release.id, "products", p.product_id);
      return {
        choice: { name: p.product_code, version: v.version, path },
        root: { id: "", path },
        paths: release.data.saleItems
          .filter((s) => s.product_version_id === v.product_version_id)
          .map((s) => knowledgePath(release.id, "sale-items", s.sale_item_id)),
      };
    });
    return searchStructured(
      db,
      projectId,
      runId,
      release,
      { scopeRevision: scope.revision, products },
      input.requirementId,
      input.query,
      input.topK,
      undefined,
      { reason: input.reason, explanation: input.explanation },
      signal,
    );
  }
  const { wiki, wikiId } = await boundWiki(db, projectId, signal);
  const result = await wiki.search(wikiId, input.query, input.topK);
  await audit(db, projectId, null, runId, "product_global_search", {
    scopeRevision: scope.revision,
    ...input,
  });
  const encoded = JSON.stringify(result);
  const bounded =
    encoded.length > 50000
      ? { truncated: true, text: encoded.slice(0, 50000) }
      : result;
  return {
    stage: "global_fallback",
    requirementId: input.requirementId,
    reason: input.reason,
    explanation: input.explanation,
    result: bounded,
    note: "范围外命中只可作为替代建议；先读取销售项及所属产品目录，确认能力与引用后 record_product_alternative，不能直接保存正式销售项匹配",
  };
}
export const alternativeSchema = z.object({
  requirementId: z.string().regex(/^T-\d+$/),
  product: productChoiceSchema,
  sales: z.string().min(1).max(200),
  reason: z.string().min(10).max(2000),
  evidence: evidenceSchema,
});
export async function recordAlternative(
  db: Database,
  projectId: string,
  runId: string,
  input: z.infer<typeof alternativeSchema>,
) {
  await requireClause(db, projectId, input.requirementId);
  const scope = await productScope(db, projectId);
  const [trace] = await db.query(
    "SELECT id FROM audit_log WHERE project_id=$1 AND action='product_global_search' AND data->>'requirementId'=$2 AND (data->>'scopeRevision')::int=$3 LIMIT 1",
    [projectId, input.requirementId, scope.revision],
  );
  if (!trace)
    throw new AppError(409, "替代建议必须来自本条款的产品内检索与全局补查流程");
  if (
    scope.selected.some(
      (p) =>
        aliases(p).includes(input.product.name) &&
        (!p.version || sameVersion(p.version, input.product.version)),
    )
  )
    throw new AppError(422, "该产品已在范围内，不应作为范围外替代建议");
  if (!input.product.path)
    throw new AppError(422, "请提供并读取替代产品的准确产品目录路径");
  const [root] = await db.query<Page>(
    "SELECT id,path,content FROM snapshots WHERE project_id=$1 AND path=$2 AND kind='product' ORDER BY created_at DESC LIMIT 1",
    [projectId, input.product.path],
  );
  const [page] = await db.query<Page>(
    "SELECT id,path,content FROM snapshots WHERE project_id=$1 AND id=$2",
    [projectId, input.evidence.snapshotId],
  );
  if (!root || !page || !belongs(page, input.product))
    throw new AppError(422, "替代销售项必须有该产品目录与正式实体证据");
  await validateCatalogSale(
    db,
    projectId,
    input.product,
    page,
    input.product.version,
  );
  const rootMeta = parseSaleEntity(root.content),
    entity = parseSaleEntity(page.content),
    e = input.evidence;
  if (
    rootMeta.moduleId ||
    entity.title !== input.sales ||
    !entity.product ||
    !aliases(input.product).includes(entity.product) ||
    (rootMeta.version &&
      input.product.version &&
      !sameVersion(rootMeta.version, input.product.version))
  )
    throw new AppError(422, "替代产品、版本或销售项证据不一致");
  const lines = page.content.split(/\r?\n/);
  if (
    e.lineEnd < e.lineStart ||
    e.lineEnd > lines.length ||
    !lines
      .slice(e.lineStart - 1, e.lineEnd)
      .join("\n")
      .includes(e.quote)
  )
    throw new AppError(422, "替代建议证据行号或原文不准确");
  await audit(db, projectId, null, runId, "product_alternative", {
    ...input,
    scopeRevision: scope.revision,
  });
  return {
    saved: true,
    label: "其他产品可满足 · 待用户确认加入范围",
    requirementId: input.requirementId,
  };
}
export async function validateCatalogSale(
  db: Database,
  projectId: string,
  choice: Choice,
  page: Page,
  itemVersion: string,
) {
  const release = await projectKnowledge(db, projectId);
  if (release) {
    const { version } = knowledgeChoice(release, choice);
    const sale = release.data.saleItems.find(
      (s) =>
        knowledgePath(release.id, "sale-items", s.sale_item_id) === page.path,
    );
    if (
      !sale ||
      sale.product_version_id !== version.product_version_id ||
      !sameVersion(version.version, itemVersion) ||
      saleMarkdown(release, sale) !== page.content
    )
      throw new AppError(422, "销售项或证据不属于本项目固定发布版本");
    return;
  }
  const entity = parseSaleEntity(page.content);
  if (entity.product && !aliases(choice).includes(entity.product))
    throw new AppError(422, "销售项所属产品与本条评估产品不一致");
  if (
    entity.version &&
    itemVersion &&
    !sameVersion(entity.version, itemVersion)
  )
    throw new AppError(422, "销售项实体版本与评估产品版本不一致");
  const [root] = await db.query<Page>(
    "SELECT id,path,content FROM snapshots WHERE project_id=$1 AND path=$2 ORDER BY created_at DESC LIMIT 1",
    [projectId, choice.path],
  );
  const pages = await db.query<Page>(
    "SELECT DISTINCT ON(path) id,path,content FROM snapshots WHERE project_id=$1 ORDER BY path,created_at DESC",
    [projectId],
  );
  if (!root) throw new AppError(422, "请先读取所选产品页");
  // A verified catalog is tied to an immutable product snapshot and scope revision.
  // Reuse it during per-evidence validation instead of fetching the entire file tree.
  const scope = await productScope(db, projectId);
  const [cached] = await db.query<{ data: Catalog }>(
    "SELECT data FROM audit_log WHERE project_id=$1 AND action='product_catalog' AND (data->>'scopeRevision')::int=$2 ORDER BY id DESC LIMIT 1",
    [projectId, scope.revision],
  );
  const catalogProduct =
    cached?.data.parserVersion === 4
      ? cached.data.products.find(
          (p) =>
            p.root.id === root.id &&
            p.choice.path === choice.path &&
            sameVersion(p.choice.version, choice.version),
        )
      : undefined;
  if (catalogProduct) {
    if (!catalogProduct.paths.includes(page.path) || !belongs(page, choice))
      throw new AppError(422, "销售项不属于所选产品版本目录");
    return;
  }
  const list = productVersionList(root.content, choice.version);
  const { wiki, wikiId } = await boundWiki(db, projectId);
  const filePaths = /\[\[[^\]/#|]+(?:[#|][^\]]*)?\]\]/.test(list)
    ? await wiki.files(wikiId)
    : [];
  const known = [...new Set([...filePaths, ...pages.map((p) => p.path)])];
  const reachable = linkedWikiPaths(list, root.path, known).filter((p) =>
    p.includes("/sale-items/"),
  );
  if (!reachable.includes(page.path) || !belongs(page, choice))
    throw new AppError(
      422,
      "销售项所属产品必须与本条结论所选产品及版本的目录一致，范围外能力只能单列替代建议",
    );
}
