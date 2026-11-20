import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Database } from "./db.js";
import { requireUser } from "./auth.js";
import { knowledgeSearchSchema, searchKnowledge } from "./knowledge-search.js";
import { z } from "zod";

const active = `FROM kb_sale_items s JOIN kb_product_versions v USING(product_version_id)
  JOIN kb_products p USING(product_id) LEFT JOIN kb_categories c USING(category_id)
  WHERE s.status='active' AND v.status='active' AND p.status='active'`;
const identity =
  "s.sale_item_id,s.name,s.module_code,p.product_id,p.name product_name,p.product_code,v.product_version_id,v.version,c.name category";
const full = `${identity}, (SELECT to_jsonb(f) FROM (SELECT s.description,s.specification_md,s.source_markdown,s.unit,s.price_type,s.fixed_price,s.currency,s.pricing_note,s.mandatory,s.authorization_note,s.prerequisites,s.limitations,s.dependency_note,s.source_path,s.source_file,s.source_sheet,s.source_row) f) fields,
  (SELECT coalesce(jsonb_agg(jsonb_build_object('id',dep.depends_on_sale_item_id,'type',dep.dependency_type,'condition',dep.condition_note,'source',dep.source_note) ORDER BY dep.dependency_id),'[]') FROM kb_sale_dependencies dep WHERE dep.sale_item_id=s.sale_item_id) dependencies`;
function detail(row: Record<string, unknown>) {
  const fields = row.fields as Record<string, unknown>;
  return {
    ...row,
    source_format: fields.source_markdown
      ? "original_markdown"
      : "structured_fields",
    content_hash: createHash("sha256")
      .update(JSON.stringify([fields, row.dependencies]))
      .digest("hex"),
  };
}
export function knowledgeSkillRoutes(app: FastifyInstance, db: Database) {
  const root = "/api/knowledge/skill";
  app.get(root + "/download", async (req, reply) => {
    requireUser(req);
    return reply
      .header(
        "Content-Disposition",
        'attachment; filename="pingbiao-knowledge.zip"',
      )
      .type("application/zip")
      .send(await readFile("agent/pingbiao-knowledge.zip"));
  });
  app.get(root + "/products", async () => {
    return {
      versions:
        await db.query(`SELECT p.product_id,p.product_code,p.name,p.summary,p.scenarios,p.boundaries,v.product_version_id,v.version,o.overview,
      (SELECT count(*)::int FROM kb_sale_items s WHERE s.product_version_id=v.product_version_id AND s.status='active') AS sale_count
      FROM kb_products p JOIN kb_product_versions v USING(product_id) LEFT JOIN kb_product_overviews o USING(product_version_id)
      WHERE p.status='active' AND v.status='active' ORDER BY p.product_id,v.product_version_id`),
    };
  });
  app.get(root + "/catalog", async (req) => {
    const { versionId, limit, cursor, view } = z
      .object({
        versionId: z.string().min(1),
        limit: z.coerce.number().int().min(1).max(100).default(25),
        cursor: z.string().default(""),
        view: z.enum(["summary", "full"]).default("summary"),
      })
      .parse(req.query);
    const [count] = await db.query<{ total: number }>(
      `SELECT count(*)::int total ${active} AND v.product_version_id=$1`,
      [versionId],
    );
    const rows = await db.query(
      `SELECT ${view === "full" ? full : identity + ",left(s.description,160) description"} ${active} AND v.product_version_id=$1 AND s.sale_item_id>$2 ORDER BY s.sale_item_id LIMIT $3`,
      [versionId, cursor, limit + 1],
    );
    const complete = rows.length <= limit,
      page = rows.slice(0, limit);
    return {
      total: count.total,
      returned: page.length,
      complete,
      next_cursor: complete ? null : page.at(-1)?.sale_item_id,
      items: view === "full" ? page.map(detail) : page,
    };
  });
  app.post(root + "/items", async (req) => {
    const { ids, versionId } = z
      .object({
        ids: z.array(z.string().min(1)).min(1).max(100),
        versionId: z.string().min(1).optional(),
      })
      .parse(req.body);
    const rows = await db.query(
      `SELECT ${full} ${active} AND s.sale_item_id=ANY($1::text[]) AND ($2::text IS NULL OR v.product_version_id=$2) ORDER BY array_position($1::text[],s.sale_item_id)`,
      [ids, versionId ?? null],
    );
    return {
      items: rows.map(detail),
      missing_ids: ids.filter(
        (id) => !rows.some((row) => row.sale_item_id === id),
      ),
    };
  });
  app.post(root + "/search", async (req) => {
    return searchKnowledge(db, knowledgeSearchSchema.strict().parse(req.body));
  });
}
