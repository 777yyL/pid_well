import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Database } from "./db.js";
import { accessProject, requireAdmin, requireUser } from "./auth.js";
import { AppError } from "./errors.js";
import { productKnowledgeSchema } from "./product-knowledge-schema.js";
import type {
  KnowledgeData,
  KnowledgeRelease,
  KnowledgeBrowse,
} from "../shared/product-knowledge.js";

const tables = [
  "kb_products",
  "kb_product_versions",
  "kb_categories",
  "kb_sale_items",
  "kb_sale_dependencies",
];
export async function migrateProductKnowledge(db: Database) {
  await db.transaction(async (tx) => {
    const existing = await tx.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name=ANY($1::text[])`,
      [tables],
    );
    if (existing.length && existing.length !== tables.length)
      throw new Error("public 业务表不完整，请先修复建表脚本");
    if (!existing.length)
      for (const statement of productKnowledgeSchema) await tx.query(statement);
    const expected: Record<string, string[]> = {
      kb_products: [
        "product_id",
        "product_code",
        "name",
        "status",
        "source_path",
      ],
      kb_product_versions: [
        "product_version_id",
        "product_id",
        "version",
        "status",
        "source_path",
      ],
      kb_categories: [
        "category_id",
        "product_version_id",
        "name",
        "sort_order",
      ],
      kb_sale_items: [
        "sale_item_id",
        "product_version_id",
        "category_id",
        "module_code",
        "specification_md",
        "status",
      ],
      kb_sale_dependencies: [
        "dependency_id",
        "sale_item_id",
        "depends_on_sale_item_id",
        "source_note",
      ],
    };
    const columns = await tx.query<{ table_name: string; column_name: string }>(
      `SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public'`,
    );
    for (const [table, names] of Object.entries(expected))
      for (const name of names)
        if (
          !columns.some((c) => c.table_name === table && c.column_name === name)
        )
          throw new Error(`public 表结构不兼容：${table}.${name}`);
    await tx.query(
      `CREATE TABLE IF NOT EXISTS public.kb_releases(id uuid PRIMARY KEY,wiki_project_id text NOT NULL,name text NOT NULL,data jsonb NOT NULL,created_by uuid REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now())`,
    );
    await tx.query(
      `CREATE TABLE IF NOT EXISTS public.kb_project_releases(project_id uuid PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,release_id uuid NOT NULL REFERENCES public.kb_releases(id))`,
    );
  });
}
export async function getProjectKnowledge(
  db: Database,
  projectId: string,
): Promise<KnowledgeRelease | null> {
  return (
    (
      await db.query<KnowledgeRelease>(
        `SELECT r.* FROM public.kb_releases r JOIN public.kb_project_releases b ON b.release_id=r.id WHERE b.project_id=$1`,
        [projectId],
      )
    )[0] ?? null
  );
}
export async function latestKnowledge(
  db: Database,
  wikiProjectId: string,
): Promise<KnowledgeRelease | null> {
  return (
    (
      await db.query<KnowledgeRelease>(
        `SELECT * FROM public.kb_releases WHERE wiki_project_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1`,
        [wikiProjectId],
      )
    )[0] ?? null
  );
}
export async function bindProjectKnowledge(
  db: Database,
  projectId: string,
  releaseId: string,
) {
  const [release] = await db.query(
    `SELECT r.id FROM public.kb_releases r JOIN projects p ON p.wiki_project_id=r.wiki_project_id WHERE p.id=$1 AND r.id=$2`,
    [projectId, releaseId],
  );
  if (!release) throw new AppError(422, "发布版本不存在或不属于项目知识空间");
  await db.query(
    `INSERT INTO public.kb_project_releases(project_id,release_id) VALUES($1,$2) ON CONFLICT(project_id) DO NOTHING`,
    [projectId, releaseId],
  );
  const bound = await getProjectKnowledge(db, projectId);
  if (bound?.id !== releaseId)
    throw new AppError(409, "项目已绑定其他知识版本");
}
const validPath = (v: string | null) =>
  v === null ||
  (/^wiki\/[\w\-./\u0080-\uffff ]+\.md$/i.test(v) &&
    !v.split("/").includes("..") &&
    !v.includes("//"));
export function validateKnowledge(data: KnowledgeData): string[] {
  const issues: string[] = [];
  const add = (s: string) => issues.push(s);
  const products = new Set(data.products.map((p) => p.product_id));
  const versions = new Set(data.versions.map((v) => v.product_version_id));
  const items = new Set(data.saleItems.map((s) => s.sale_item_id));
  if (!products.size || !versions.size || !items.size)
    add("至少需要一个 active 产品、版本和销售项");
  for (const p of data.products)
    if (!validPath(p.source_path)) add(`产品 ${p.product_code} 来源路径不合法`);
  for (const v of data.versions) {
    if (!products.has(v.product_id)) add(`版本 ${v.version} 的产品未启用`);
    if (!/^v[0-9]+(\.[0-9]+)*$/.test(v.version))
      add(`版本 ${v.version} 格式不合法`);
    if (!validPath(v.source_path)) add(`版本 ${v.version} 来源路径不合法`);
  }
  for (const s of data.saleItems) {
    const version = data.versions.find(
      (v) => v.product_version_id === s.product_version_id,
    );
    const product = data.products.find(
      (p) => p.product_id === version?.product_id,
    );
    const label = `${product?.product_code ?? "未知产品"} / ${version?.version ?? "未知版本"} / ${s.name}（${s.sale_item_id}）`;
    if (!versions.has(s.product_version_id))
      add(`销售项 ${label} 的版本未启用`);
    if (!validPath(s.source_path)) add(`销售项 ${label} 来源路径不合法`);
    if (
      s.category_id &&
      !data.categories.some(
        (c) =>
          c.category_id === s.category_id &&
          c.product_version_id === s.product_version_id,
      )
    )
      add(`销售项 ${label} 分类不属于其版本`);
  }
  const edges = new Map<string, string[]>();
  for (const d of data.dependencies) {
    if (!items.has(d.sale_item_id) || !items.has(d.depends_on_sale_item_id))
      add(`依赖 ${d.dependency_id} 的目标或源销售项未启用`);
    if (d.sale_item_id === d.depends_on_sale_item_id)
      add(`依赖 ${d.dependency_id} 存在自循环`);
    edges.set(d.sale_item_id, [
      ...(edges.get(d.sale_item_id) ?? []),
      d.depends_on_sale_item_id,
    ]);
  }
  const done = new Set<string>(),
    visiting = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (done.has(id)) return false;
    visiting.add(id);
    for (const next of edges.get(id) ?? []) if (visit(next)) return true;
    visiting.delete(id);
    done.add(id);
    return false;
  };
  for (const id of items)
    if (visit(id)) {
      add("销售项依赖存在环路");
      break;
    }
  return issues.slice(0, 20);
}
export function knowledgeWarnings(data: KnowledgeData) {
  return data.saleItems.flatMap((sale) => {
    const missing = [
      !sale.module_code?.trim() && "模块编码未提供",
      !sale.specification_md?.trim() && "技术规格待确认",
    ].filter(Boolean);
    if (!missing.length) return [];
    const version = data.versions.find(
      (v) => v.product_version_id === sale.product_version_id,
    );
    const product = data.products.find(
      (p) => p.product_id === version?.product_id,
    );
    return [
      {
        saleItemId: sale.sale_item_id,
        product: product?.product_code ?? "未知产品",
        version: version?.version ?? "未知版本",
        sale: sale.name,
        message: missing.join("；"),
      },
    ];
  });
}
async function readDraft(db: Database): Promise<KnowledgeData> {
  const products = await db.query<KnowledgeData["products"][number]>(
    `SELECT * FROM public.kb_products WHERE status='active' ORDER BY product_id`,
  );
  const versions = await db.query<KnowledgeData["versions"][number]>(
    `SELECT * FROM public.kb_product_versions WHERE status='active' ORDER BY product_version_id`,
  );
  const categories = await db.query<KnowledgeData["categories"][number]>(
    `SELECT * FROM public.kb_categories WHERE product_version_id=ANY($1::text[]) ORDER BY sort_order,category_id`,
    [versions.map((v) => v.product_version_id)],
  );
  const saleItems = await db.query<KnowledgeData["saleItems"][number]>(
    `SELECT * FROM public.kb_sale_items WHERE status='active' ORDER BY sale_item_id`,
  );
  const dependencies = await db.query<KnowledgeData["dependencies"][number]>(
    `SELECT * FROM public.kb_sale_dependencies WHERE sale_item_id=ANY($1::text[]) ORDER BY dependency_id`,
    [saleItems.map((s) => s.sale_item_id)],
  );
  return { products, versions, categories, saleItems, dependencies };
}
const text = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";
function page(value: unknown, fallback: number, max: number) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > max)
    throw new AppError(422, "分页参数不合法");
  return n;
}
export function knowledgeRoutes(app: FastifyInstance, db: Database) {
  app.get("/api/knowledge/releases", async (request) => {
    requireUser(request);
    const wiki = text((request.query as Record<string, unknown>).wikiProjectId);
    if (!wiki) throw new AppError(422, "缺少 wikiProjectId");
    const releases = await db.query(
      `SELECT id,name,created_at,jsonb_array_length(data->'products') AS "productCount",jsonb_array_length(data->'saleItems') AS "saleCount" FROM public.kb_releases WHERE wiki_project_id=$1 ORDER BY created_at DESC,id DESC`,
      [wiki],
    );
    const [counts] = await db.query<{
      products: number;
      versions: number;
      saleItems: number;
    }>(
      `SELECT (SELECT count(*)::int FROM public.kb_products) products,(SELECT count(*)::int FROM public.kb_product_versions) versions,(SELECT count(*)::int FROM public.kb_sale_items) "saleItems"`,
    );
    return { releases, draftCounts: counts };
  });
  app.post("/api/knowledge/releases", async (request, reply) => {
    const user = requireAdmin(request);
    const body = (request.body ?? {}) as Record<string, unknown>;
    const wiki = text(body.wikiProjectId),
      name = text(body.name);
    if (!/^[\w-]+$/.test(wiki) || !name || name.length > 200)
      throw new AppError(422, "知识空间标识或发布名称不合法");
    return db.transaction(async (tx) => {
      await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      const data = await readDraft(tx);
      const issues = validateKnowledge(data);
      if (issues.length)
        return reply
          .code(422)
          .send({ error: "知识库校验失败：" + issues.join("；"), issues });
      const id = randomUUID();
      const [release] = await tx.query<KnowledgeRelease>(
        `INSERT INTO public.kb_releases(id,wiki_project_id,name,data,created_by) VALUES($1,$2,$3,$4::jsonb,$5) RETURNING *`,
        [id, wiki, name, JSON.stringify(data), user.id],
      );
      return reply
        .code(201)
        .send({ release, warnings: knowledgeWarnings(data) });
    });
  });
  app.get("/api/projects/:id/knowledge/catalog", async (request) => {
    const { id } = request.params as { id: string };
    const project = await accessProject(db, requireUser(request), id);
    const q = request.query as Record<string, unknown>;
    const offset = page(q.offset, 0, 1000000),
      limit = page(q.limit, 20, 100);
    if (!limit) throw new AppError(422, "limit 必须大于 0");
    const release =
      (await getProjectKnowledge(db, id)) ??
      (await latestKnowledge(db, String(project.wiki_project_id)));
    const empty: KnowledgeBrowse = {
      releaseId: null,
      versions: [],
      categories: [],
      items: [],
      total: 0,
      offset,
      limit,
    };
    if (!release) return empty;
    const data = release.data;
    let candidates = data.products.filter(
      (p) =>
        (!text(q.productId) ||
          p.product_id === text(q.productId) ||
          p.product_code === text(q.productId)) &&
        (!text(q.name) ||
          p.product_code === text(q.name) ||
          p.name === text(q.name)),
    );
    if (text(q.path))
      candidates = candidates.filter(
        (p) =>
          p.source_path === text(q.path) ||
          `wiki/structured/${release.id}/products/${createHash("sha256").update(p.product_id).digest("hex")}.md` ===
            text(q.path) ||
          data.versions.some(
            (v) =>
              v.product_id === p.product_id && v.source_path === text(q.path),
          ) ||
          data.saleItems.some(
            (s) =>
              s.source_path === text(q.path) &&
              data.versions.some(
                (v) =>
                  v.product_id === p.product_id &&
                  v.product_version_id === s.product_version_id,
              ),
          ),
      );
    if (candidates.length > 1)
      throw new AppError(422, "产品匹配存在歧义，请指定 productId");
    const product = candidates[0];
    if (!product)
      return { ...empty, releaseId: release.id, releaseName: release.name };
    const versions = data.versions.filter(
      (v) => v.product_id === product.product_id,
    );
    const selected = versions.filter(
      (v) => !text(q.version) || v.version === text(q.version),
    );
    if (selected.length > 1)
      throw new AppError(422, "版本匹配存在歧义，请指定 version");
    const version = selected[0];
    if (!version)
      return {
        ...empty,
        releaseId: release.id,
        releaseName: release.name,
        product,
        versions,
      };
    const all = data.saleItems.filter(
      (s) => s.product_version_id === version.product_version_id,
    );
    const categories = data.categories
      .filter((c) => c.product_version_id === version.product_version_id)
      .map((c) => ({
        ...c,
        count: all.filter((s) => s.category_id === c.category_id).length,
      }));
    const unclassified = all.filter((s) => !s.category_id).length;
    if (unclassified)
      categories.push({
        category_id: "__uncategorized__",
        product_version_id: version.product_version_id,
        name: "未分类",
        sort_order: 2147483647,
        count: unclassified,
      });
    const items = all.filter(
      (s) =>
        (!text(q.categoryId) ||
          (text(q.categoryId) === "__uncategorized__"
            ? !s.category_id
            : s.category_id === text(q.categoryId))) &&
        (!text(q.q) ||
          `${s.name} ${s.module_code ?? ""} ${s.description ?? ""}`
            .toLowerCase()
            .includes(text(q.q).toLowerCase())),
    );
    return {
      releaseId: release.id,
      releaseName: release.name,
      product,
      version,
      versions,
      categories,
      items: items
        .slice(offset, offset + limit)
        .map(({ specification_md, ...s }) => s),
      total: items.length,
      offset,
      limit,
    };
  });
  app.get("/api/projects/:id/knowledge/items/:saleItemId", async (request) => {
    const { id, saleItemId } = request.params as {
      id: string;
      saleItemId: string;
    };
    const project = await accessProject(db, requireUser(request), id);
    const bound = await getProjectKnowledge(db, id);
    const releaseId = text(
      (request.query as Record<string, unknown>).releaseId,
    );
    if (
      releaseId &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        releaseId,
      )
    )
      throw new AppError(422, "releaseId 格式不合法");
    if (bound && releaseId && releaseId !== bound.id)
      throw new AppError(403, "只能访问项目绑定的知识版本");
    const release =
      bound ??
      (releaseId
        ? (
            await db.query<KnowledgeRelease>(
              `SELECT * FROM public.kb_releases WHERE id=$1 AND wiki_project_id=$2`,
              [releaseId, project.wiki_project_id],
            )
          )[0]
        : await latestKnowledge(db, String(project.wiki_project_id)));
    if (!release) throw new AppError(404, "知识版本不存在");
    const item = release.data.saleItems.find(
      (s) => s.sale_item_id === saleItemId,
    );
    if (!item) throw new AppError(404, "销售项不存在");
    return {
      releaseId: release.id,
      item,
      dependencies: release.data.dependencies.filter(
        (d) => d.sale_item_id === saleItemId,
      ),
    };
  });
}
