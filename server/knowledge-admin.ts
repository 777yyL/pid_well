import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Database } from "./db.js";
import { audit } from "./db.js";
import { requireAdmin, requireUser, accessProject } from "./auth.js";
import { AppError } from "./errors.js";
import { liveKnowledge } from "./product-knowledge.js";
import {
  generateOverview,
  overviewInput,
  saveOverview,
  searchProductOverviews,
} from "./product-overviews.js";
import {
  knowledgeSearchSchema,
  searchKnowledge,
  refreshKnowledgeIndex,
  knowledgeDocuments,
  indexHash,
} from "./knowledge-search.js";
import { loadSemanticSettings } from "./semantic-settings.js";
import { documentChunks } from "./knowledge-retrieval.js";

const id = z.string().trim().min(1).max(500),
  text = z.string().max(200000).nullable().optional();
const status = z.enum(["draft", "active", "retired"]).default("active");
export const knowledgeEntities = {
  products: {
    table: "kb_products",
    key: "product_id",
    schema: z
      .object({
        product_id: id,
        product_code: id,
        name: id,
        product_line: text,
        department: text,
        owner: text,
        summary: text,
        scenarios: text,
        boundaries: text,
        source_path: text,
        status,
      })
      .strict(),
  },
  versions: {
    table: "kb_product_versions",
    key: "product_version_id",
    schema: z
      .object({
        product_version_id: id,
        product_id: id,
        version: z.string().regex(/^v\d+(\.\d+)*$/),
        status,
        effective_date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .nullable()
          .optional(),
        source_path: text,
      })
      .strict(),
  },
  categories: {
    table: "kb_categories",
    key: "category_id",
    schema: z
      .object({
        category_id: id,
        product_version_id: id,
        name: id,
        sort_order: z.number().int().default(0),
      })
      .strict(),
  },
  sales: {
    table: "kb_sale_items",
    key: "sale_item_id",
    schema: z
      .object({
        sale_item_id: id,
        product_version_id: id,
        category_id: id.nullable().optional(),
        module_code: text,
        name: id,
        description: text,
        specification_md: text,
        unit: text,
        price_type: z
          .enum(["fixed", "formula", "inquiry", "unknown"])
          .default("unknown"),
        fixed_price: z
          .union([z.number().nonnegative(), z.string().regex(/^\d+(\.\d+)?$/)])
          .nullable()
          .optional(),
        currency: z
          .string()
          .regex(/^[A-Z]{3}$/)
          .nullable()
          .optional(),
        pricing_note: text,
        mandatory: z.boolean().nullable().optional(),
        authorization_note: text,
        prerequisites: text,
        limitations: text,
        dependency_note: text,
        source_path: text,
        source_file: text,
        source_sheet: text,
        source_row: z.number().int().positive().nullable().optional(),
        status,
      })
      .strict(),
  },
  dependencies: {
    table: "kb_sale_dependencies",
    key: "dependency_id",
    schema: z
      .object({
        dependency_id: id,
        sale_item_id: id,
        depends_on_sale_item_id: id,
        dependency_type: z.enum(["required", "conditional", "optional"]),
        condition_note: text,
        source_note: id,
      })
      .strict(),
  },
};
type Entity = keyof typeof knowledgeEntities;
function entity(value: string) {
  if (!Object.hasOwn(knowledgeEntities, value))
    throw new AppError(404, "未知知识实体");
  return knowledgeEntities[value as Entity];
}
async function upsert(db: Database, kind: string, raw: unknown) {
  const config = entity(kind),
    value = config.schema.parse(raw) as Record<string, unknown>;
  if (kind === "sales") {
    if (
      value.price_type === "fixed" &&
      (value.fixed_price == null || !value.currency)
    )
      throw new AppError(422, "固定价销售项需要填写价格与币种");
    if (value.price_type !== "fixed" && value.fixed_price != null)
      throw new AppError(422, "非固定价销售项请清空固定价格");
  }
  if (kind === "dependencies") {
    if (value.sale_item_id === value.depends_on_sale_item_id)
      throw new AppError(422, "销售项不能依赖自身");
    if (
      value.dependency_type === "conditional" &&
      !String(value.condition_note ?? "").trim()
    )
      throw new AppError(422, "条件依赖需要填写生效条件");
  }
  const columns = Object.keys(value),
    params = columns.map((c) => value[c] ?? null);
  const updates = columns
    .filter((c) => c !== config.key)
    .map((c) => `${c}=EXCLUDED.${c}`);
  const [row] = await db.query(
    `INSERT INTO public.${config.table}(${columns.join(",")}) VALUES(${columns.map((_, i) => "$" + (i + 1)).join(",")})
    ON CONFLICT(${config.key}) DO UPDATE SET ${updates.join(",")} RETURNING *`,
    params,
  );
  return row;
}
export function knowledgeAdminRoutes(app: FastifyInstance, db: Database) {
  const jobs = new Map<
    string,
    { status: string; error?: string; controller: AbortController }
  >();
  const promises = new Set<Promise<unknown>>();
  function queue(key: string, fn: (signal: AbortSignal) => Promise<unknown>) {
    if (jobs.get(key)?.status === "running") return;
    const job = {
      status: "running",
      controller: new AbortController(),
      error: undefined as string | undefined,
    };
    jobs.set(key, job);
    const promise = fn(job.controller.signal).then(
      () => {
        job.status = "completed";
      },
      (e) => {
        job.status = "failed";
        job.error = (e as Error).message.slice(0, 1000);
      },
    );
    promises.add(promise);
    void promise.finally(() => promises.delete(promise));
  }
  app.addHook("onClose", async () => {
    for (const job of jobs.values()) job.controller.abort();
    await Promise.allSettled(promises);
  });
  app.get("/api/knowledge/products", async (request) => {
    requireUser(request);
    const source = await liveKnowledge(db);
    return {
      products: source.data.products,
      versions: source.data.versions,
      categories: source.data.categories,
    };
  });
  app.get("/api/knowledge/retrieval-options", async (request) => {
    requireUser(request);
    const { enabled, mode, topK, minSimilarity } =
      await loadSemanticSettings(db);
    return { enabled, mode, topK, minSimilarity };
  });
  app.get("/api/knowledge/admin/references", async (request) => {
    requireAdmin(request);
    const [products, versions, categories, sales] = await Promise.all([
      db.query(
        "SELECT product_id,product_code,name,status FROM kb_products ORDER BY product_code",
      ),
      db.query(
        "SELECT product_version_id,product_id,version,status FROM kb_product_versions ORDER BY product_id,version",
      ),
      db.query(
        "SELECT category_id,product_version_id,name FROM kb_categories ORDER BY sort_order,name",
      ),
      db.query(
        "SELECT sale_item_id,product_version_id,name,status FROM kb_sale_items ORDER BY name",
      ),
    ]);
    return { products, versions, categories, sales };
  });
  app.post("/api/knowledge/search", async (request) => {
    requireUser(request);
    return searchKnowledge(db, knowledgeSearchSchema.parse(request.body));
  });
  app.post("/api/knowledge/products/search", async (request) => {
    requireUser(request);
    const input = knowledgeSearchSchema.parse(request.body);
    return searchProductOverviews(db, input.query, input);
  });
  app.post("/api/projects/:id/knowledge/search", async (request) => {
    const { id } = request.params as { id: string };
    await accessProject(db, requireUser(request), id);
    return searchKnowledge(db, knowledgeSearchSchema.parse(request.body), {
      projectId: id,
    });
  });
  app.get("/api/knowledge/admin/:kind", async (request) => {
    requireAdmin(request);
    const { kind } = request.params as { kind: string };
    const config = entity(kind);
    const input = z
      .object({
        q: z.string().default(""),
        versionId: z.string().default(""),
        offset: z.coerce.number().int().min(0).default(0),
        limit: z.coerce.number().int().min(1).max(100).default(30),
      })
      .parse(request.query);
    const params: unknown[] = [],
      conditions: string[] = [];
    if (input.versionId && ["sales", "categories"].includes(kind)) {
      params.push(input.versionId);
      conditions.push(`product_version_id=$${params.length}`);
    }
    if (input.q) {
      params.push("%" + input.q + "%");
      conditions.push(`to_jsonb(t)::text ILIKE $${params.length}`);
    }
    const where = conditions.length ? " WHERE " + conditions.join(" AND ") : "";
    const [count] = await db.query<{ total: number }>(
      `SELECT count(*)::int total FROM public.${config.table} t${where}`,
      params,
    );
    return {
      total: count.total,
      items: await db.query(
        `SELECT * FROM public.${config.table} t${where} ORDER BY ${config.key} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, input.limit, input.offset],
      ),
    };
  });
  app.put("/api/knowledge/admin/:kind/:id", async (request) => {
    const user = requireAdmin(request),
      { kind, id } = request.params as { kind: string; id: string };
    const config = entity(kind);
    if ((request.body as Record<string, unknown>)?.[config.key] !== id)
      throw new AppError(422, "记录 ID 与路径不一致");
    const row = await upsert(db, kind, request.body);
    await audit(db, null, user.id, null, "knowledge_updated", { kind, id });
    // External SQL imports are detected by the periodic content-hash scan too.
    if (kind === "sales")
      await db.query("DELETE FROM kb_index_state WHERE sale_item_id=$1", [id]);
    queue("index", (signal) => refreshKnowledgeIndex(db, signal));
    return row;
  });
  app.delete("/api/knowledge/admin/:kind/:id", async (request) => {
    const user = requireAdmin(request),
      { kind, id } = request.params as { kind: string; id: string };
    const config = entity(kind);
    const rows = await db.query(
      `DELETE FROM public.${config.table} WHERE ${config.key}=$1 RETURNING ${config.key}`,
      [id],
    );
    if (!rows.length) throw new AppError(404, "记录不存在");
    await audit(db, null, user.id, null, "knowledge_deleted", { kind, id });
    return { ok: true };
  });
  app.post(
    "/api/knowledge/admin/import",
    { bodyLimit: 32 * 1024 * 1024 },
    async (request) => {
      const user = requireAdmin(request);
      const input = z
        .object({
          products: z.array(z.unknown()).default([]),
          versions: z.array(z.unknown()).default([]),
          categories: z.array(z.unknown()).default([]),
          sales: z.array(z.unknown()).default([]),
          dependencies: z.array(z.unknown()).default([]),
        })
        .strict()
        .parse(request.body);
      await db.transaction(async (tx) => {
        for (const [kind, rows] of Object.entries(input))
          for (const row of rows) await upsert(tx, kind, row);
      });
      await audit(db, null, user.id, null, "knowledge_imported", {
        counts: Object.fromEntries(
          Object.entries(input).map(([key, rows]) => [key, rows.length]),
        ),
      });
      queue("index", (signal) => refreshKnowledgeIndex(db, signal));
      return { ok: true };
    },
  );
  app.get("/api/knowledge/admin/overviews/:id", async (request) => {
    requireAdmin(request);
    const { id } = request.params as { id: string };
    const source = await liveKnowledge(db),
      { hash } = overviewInput(source, id),
      current = source.overviews?.find((o) => o.product_version_id === id);
    return {
      current: current
        ? { ...current, stale: current.input_hash !== hash }
        : null,
      job: jobs.get("overview:" + id)
        ? {
            status: jobs.get("overview:" + id)!.status,
            error: jobs.get("overview:" + id)!.error,
          }
        : null,
    };
  });
  app.put("/api/knowledge/admin/overviews/:id", async (request) => {
    requireAdmin(request);
    return saveOverview(
      db,
      (request.params as { id: string }).id,
      request.body,
    );
  });
  app.post(
    "/api/knowledge/admin/overviews/:id/generate",
    async (request, reply) => {
      const user = requireAdmin(request),
        { id } = request.params as { id: string };
      overviewInput(await liveKnowledge(db), id);
      queue("overview:" + id, (signal) =>
        generateOverview(db, user.id, id, signal),
      );
      return reply.code(202).send({ status: "running" });
    },
  );
  app.get("/api/knowledge/admin/index", async (request) => {
    requireAdmin(request);
    const source = await liveKnowledge(db),
      settings = await loadSemanticSettings(db);
    const states = await db.query<{
      sale_item_id: string;
      input_hash: string;
      status: string;
      error: string | null;
    }>("SELECT * FROM kb_index_state");
    const items = knowledgeDocuments(source).map((doc) => {
      const state = states.find((s) => s.sale_item_id === doc.id);
      const status =
        state?.input_hash === indexHash(documentChunks(doc), settings)
          ? state.status
          : "pending";
      return {
        saleItemId: doc.id,
        name: doc.title,
        status,
        error: status === "failed" ? state?.error : null,
      };
    });
    return {
      enabled: settings.enabled,
      total: items.length,
      counts: Object.fromEntries(
        ["pending", "indexing", "ready", "failed"].map((status) => [
          status,
          items.filter((i) => i.status === status).length,
        ]),
      ),
      failures: items.filter((i) => i.status === "failed"),
      job: jobs.get("index")?.status,
    };
  });
  app.post("/api/knowledge/admin/index/rebuild", async (request, reply) => {
    requireAdmin(request);
    await db.query("UPDATE kb_index_state SET status='pending'");
    queue("index", (signal) => refreshKnowledgeIndex(db, signal));
    return reply.code(202).send({ status: "running" });
  });
}
