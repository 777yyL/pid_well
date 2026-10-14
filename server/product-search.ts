import { posix } from "node:path";
import { z } from "zod";
import { parse as parseYaml } from "yaml";
import type { Database } from "./db.js";
import { audit } from "./db.js";
import { AppError } from "./errors.js";
import { WikiClient, snapshotPage, PRODUCT_OVERVIEW_PATH } from "./wiki.js";
import { parseSaleEntity } from "./sale-entity.js";
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
  const pages = await db.query<Page>(
    "SELECT DISTINCT ON(path) id,path,content FROM snapshots WHERE project_id=$1 AND kind='product' ORDER BY path,created_at DESC",
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
  let loaded = offset;
  for (const path of paths.slice(offset, offset + count)) {
    signal?.throwIfAborted();
    const [cached] = await db.query<Page>(
      "SELECT id,path,content FROM snapshots WHERE project_id=$1 AND path=$2 ORDER BY created_at DESC LIMIT 1",
      [projectId, path],
    );
    const page =
      cached ??
      (await snapshotPage(db, projectId, path, await wiki.read(wikiId, path)));
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
export async function searchSelected(
  db: Database,
  projectId: string,
  runId: string,
  requirementId: string,
  query: string,
  topK: number,
  signal?: AbortSignal,
) {
  await requireClause(db, projectId, requirementId);
  const catalog = await selectedCatalog(db, projectId, runId, signal);
  const paths = [...new Set(catalog.products.flatMap((p) => p.paths))];
  const seen = await db.query<{ path: string }>(
    "SELECT DISTINCT data->>'path' AS path FROM audit_log WHERE project_id=$1 AND action='catalog_page_read' AND (data->>'scopeRevision')::int=$2",
    [projectId, catalog.scopeRevision],
  );
  const read = new Set(seen.map((p) => p.path));
  if (paths.some((p) => !read.has(p)))
    throw new AppError(
      409,
      "请先用 wiki_product_catalog 分页读取完整销售项目录，再进行产品内检索；禁止直接全局搜索",
    );
  const pages = await db.query<Page>(
    "SELECT DISTINCT ON(path) id,path,content FROM snapshots WHERE project_id=$1 ORDER BY path,created_at DESC",
    [projectId],
  );
  const terms = [
    ...new Set(query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []),
  ];
  const tokens = terms.flatMap((t) =>
    /[\u3400-\u9fff]/.test(t) && t.length > 2
      ? [
          t,
          ...Array.from({ length: t.length - 1 }, (_, i) => t.slice(i, i + 2)),
        ]
      : [t],
  );
  const hits = pages
    .flatMap((page) => {
      const owners = catalog.products.filter(
        (p) => p.paths.includes(page.path) && belongs(page, p.choice),
      );
      if (!owners.length) return [];
      const entity = parseSaleEntity(page.content),
        text = page.content.toLowerCase();
      const score = tokens.reduce(
        (total, t) =>
          total +
          (text.includes(t)
            ? (entity.title.toLowerCase().includes(t) ? 4 : 1) * t.length
            : 0),
        0,
      );
      return score
        ? [
            {
              path: page.path,
              snapshotId: page.id,
              sales: entity.title,
              products: owners.map((p) => p.choice),
              score,
            },
          ]
        : [];
    })
    .sort((a, b) => b.score - a.score);
  await audit(db, projectId, null, runId, "product_scoped_search", {
    scopeRevision: catalog.scopeRevision,
    requirementId,
    query,
    matchCount: hits.length,
    paths: hits.slice(0, topK).map((h) => h.path),
    directoryEmpty: !paths.length,
  });
  return {
    stage: "selected_product",
    requirementId,
    scopeRevision: catalog.scopeRevision,
    total: hits.length,
    results: hits.slice(0, topK),
    note: "仅已选产品目录内、所属产品及版本一致的正式销售项；候选相关不等于满足，仍需 wiki_read 核实原文与规格",
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
