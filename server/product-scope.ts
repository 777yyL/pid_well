import { z } from "zod";
import type { Database } from "./db.js";
import { audit } from "./db.js";
import { AppError } from "./errors.js";
import { validateCatalogSale, sameVersion } from "./product-search.js";
import { overviewProduct } from "./product-overview.js";
import { parseSaleEntity } from "./sale-entity.js";
import {
  productCandidateSchema,
  productCombinationSchema,
  productChoiceSchema,
  type ProductScope,
  type AssessmentInput,
} from "../shared/domain.js";
export async function productScope(
  db: Database,
  projectId: string,
): Promise<ProductScope> {
  const [row] = await db.query<ProductScope>(
    "SELECT revision,status,recommendations,selected,strategy,confirmed_by FROM product_scopes WHERE project_id=$1",
    [projectId],
  );
  const [recommendation] = await db.query<{
    data: { combinations?: ProductScope["combinations"] };
  }>(
    "SELECT data FROM audit_log WHERE project_id=$1 AND action IN ('products_recommended','product_plans_recommended') ORDER BY id DESC LIMIT 1",
    [projectId],
  );
  const [overview] = row?.recommendations.length
    ? await db.query<{ content: string }>(
        "SELECT content FROM snapshots WHERE project_id=$1 AND kind='overview' ORDER BY created_at DESC LIMIT 1",
        [projectId],
      )
    : [];
  return row
    ? {
        ...row,
        recommendations: row.recommendations.map((p) => {
          const info = overview
            ? overviewProduct(overview.content, p)
            : undefined;
          return info
            ? {
                ...p,
                ...Object.fromEntries(
                  Object.entries(info).filter(([, v]) => !!v),
                ),
              }
            : p;
        }),
        combinations: recommendation?.data.combinations ?? [],
      }
    : {
        revision: 1,
        status: "pending",
        recommendations: [],
        selected: [],
        strategy: "",
        confirmed_by: null,
      };
}
function validateProductPlans(
  candidates: ProductScope["recommendations"],
  combinations: NonNullable<ProductScope["combinations"]>,
) {
  for (const combination of combinations) {
    const identities = combination.products.map((p) =>
      JSON.stringify([p.name, p.version]),
    );
    if (new Set(identities).size !== identities.length)
      throw new AppError(422, "推荐组合不能重复包含同一产品及版本");
    if (
      combination.products.some(
        (p) =>
          !candidates.some((c) => c.name === p.name && c.version === p.version),
      )
    )
      throw new AppError(422, "推荐组合只能包含本次已提供证据的候选产品及版本");
  }
}
export async function recommendProductPlans(
  db: Database,
  projectId: string,
  input: unknown,
  runId: string,
  expectedRevision: number,
) {
  const combinations = productCombinationSchema
    .array()
    .min(1)
    .max(5)
    .parse(input);
  return db.transaction(async (tx) => {
    await tx.query(
      "SELECT project_id FROM product_scopes WHERE project_id=$1 FOR UPDATE",
      [projectId],
    );
    const scope = await productScope(tx, projectId);
    if (scope.revision !== expectedRevision)
      throw new AppError(409, "产品推荐或范围已更新，请重新读取项目状态");
    if (!scope.recommendations.length)
      throw new AppError(409, "请先读取产品总览并生成候选产品");
    validateProductPlans(scope.recommendations, combinations);
    await audit(tx, projectId, null, runId, "product_plans_recommended", {
      combinations,
      scopeRevision: scope.revision,
    });
    return productScope(tx, projectId);
  });
}
export async function recommendProducts(
  db: Database,
  projectId: string,
  input: unknown,
  runId: string,
  combinationInput: unknown = [],
) {
  const candidates = productCandidateSchema.array().min(1).max(20).parse(input);
  const combinations = productCombinationSchema
    .array()
    .max(5)
    .parse(combinationInput);
  validateProductPlans(candidates, combinations);
  if (
    new Set(candidates.map((c) => c.name + "@" + c.version)).size !==
    candidates.length
  )
    throw new AppError(422, "候选产品不能重复");
  return db.transaction(async (tx) => {
    const [scope] = await tx.query<{ status: string }>(
      "SELECT status FROM product_scopes WHERE project_id=$1 FOR UPDATE",
      [projectId],
    );
    if (scope?.status === "confirmed" || scope?.status === "legacy")
      throw new AppError(
        409,
        "用户已确定产品范围，不能覆盖选择；已有评估结果请新建项目比较其它策略",
      );
    for (const candidate of candidates) {
      const infoEvidence = candidate.evidence.map((e) => e.quote).join("\n");
      for (const field of [
        "productName",
        "productId",
        "productLine",
        "department",
        "owner",
      ] as const)
        if (candidate[field] && !infoEvidence.includes(candidate[field]!))
          throw new AppError(
            422,
            "产品基本信息必须有总览原文证据，不得推测标识、产品线、部门或负责人",
          );
      for (const e of candidate.evidence) {
        const [p] = await tx.query<{ content: string }>(
          "SELECT content FROM snapshots WHERE id=$1 AND project_id=$2 AND kind=$3",
          [e.snapshotId, projectId, "overview"],
        );
        const lines = p?.content.split(/\r?\n/);
        if (
          !lines ||
          e.lineEnd < e.lineStart ||
          e.lineEnd > lines.length ||
          !lines
            .slice(e.lineStart - 1, e.lineEnd)
            .join("\n")
            .includes(e.quote)
        )
          throw new AppError(422, "产品推荐必须引用本项目知识库总览的准确证据");
      }
    }
    await tx.query(
      "INSERT INTO product_scopes(project_id,recommendations) VALUES($1,$2) ON CONFLICT(project_id) DO UPDATE SET recommendations=EXCLUDED.recommendations,revision=product_scopes.revision+1,updated_at=now()",
      [projectId, JSON.stringify(candidates)],
    );
    await audit(tx, projectId, null, runId, "products_recommended", {
      candidates,
      combinations,
    });
    return productScope(tx, projectId);
  });
}
export const selectionSchema = z.object({
  expectedRevision: z.number().int().positive(),
  selected: productChoiceSchema.array().min(1).max(20),
  strategy: z.string().trim().max(2000).default(""),
});
export async function selectProducts(
  db: Database,
  projectId: string,
  userId: string,
  input: unknown,
) {
  const value = selectionSchema.parse(input);
  if (
    new Set(value.selected.map((c) => c.name + "@" + c.version)).size !==
    value.selected.length
  )
    throw new AppError(422, "选择的产品不能重复");
  return db.transaction(async (tx) => {
    await tx.query("SELECT id FROM projects WHERE id=$1 FOR UPDATE", [
      projectId,
    ]);
    const [scope] = await tx.query<ProductScope>(
      "SELECT revision,status,recommendations,selected,strategy,confirmed_by FROM product_scopes WHERE project_id=$1 FOR UPDATE",
      [projectId],
    );
    if ((scope?.revision ?? 1) !== value.expectedRevision)
      throw new AppError(409, "产品推荐或选择已更新，请刷新后确认");
    const [active] = await tx.query(
      "SELECT id FROM runs WHERE project_id=$1 AND status IN ('queued','running') LIMIT 1",
      [projectId],
    );
    if (active)
      throw new AppError(
        409,
        "请等待 Agent 本轮结束后再确认产品，避免执行期间切换范围",
      );
    const [existing] = await tx.query(
      "SELECT id FROM assessments WHERE project_id=$1 LIMIT 1",
      [projectId],
    );
    if (existing) {
      const previous = scope?.selected ?? [];
      if (
        scope?.status !== "confirmed" ||
        previous.some(
          (p) =>
            !value.selected.some(
              (n) =>
                n.name === p.name &&
                n.version === p.version &&
                n.path === p.path,
            ),
        )
      )
        throw new AppError(
          409,
          "已有匹配结果，只能追加产品；不能移除或替换原产品及版本",
        );
      const suggestions = await tx.query<{
        data: { product: { name: string; version: string; path: string } };
      }>(
        "SELECT data FROM audit_log WHERE project_id=$1 AND action='product_alternative'",
        [projectId],
      );
      for (const added of value.selected.filter(
        (n) =>
          !previous.some((p) => p.name === n.name && p.version === n.version),
      ))
        if (
          !suggestions.some(
            (s) =>
              s.data.product.name === added.name &&
              s.data.product.version === added.version &&
              s.data.product.path === added.path,
          )
        )
          throw new AppError(
            422,
            "追加产品需要先有已核实的范围外建议，再由用户确认加入",
          );
    }
    await tx.query(
      "INSERT INTO product_scopes(project_id,status,selected,strategy,confirmed_by) VALUES($1,'confirmed',$2,$3,$4) ON CONFLICT(project_id) DO UPDATE SET status='confirmed',selected=EXCLUDED.selected,strategy=EXCLUDED.strategy,confirmed_by=EXCLUDED.confirmed_by,revision=product_scopes.revision+1,updated_at=now()",
      [projectId, JSON.stringify(value.selected), value.strategy, userId],
    );
    await audit(tx, projectId, userId, null, "products_selected", value);
    return productScope(tx, projectId);
  });
}
export async function enforceProductScope(
  db: Database,
  projectId: string,
  item: AssessmentInput,
) {
  const scope = await productScope(db, projectId);
  if (scope.status === "legacy") return;
  if (scope.status !== "confirmed")
    throw new AppError(
      409,
      "请先在产品选型页确认推荐产品或自定义产品，再进行销售项匹配",
    );
  const selected = scope.selected.find(
    (p) =>
      p.name === item.product &&
      (!p.version || sameVersion(p.version, item.version)),
  );
  if (!selected)
    throw new AppError(
      422,
      "评估的产品/版本不在用户确认范围内，请按已选产品匹配",
    );
  const pages = await db.query<{ path: string; content: string }>(
    "SELECT path,content FROM snapshots WHERE project_id=$1 AND kind=$2",
    [projectId, "product"],
  );
  const root = pages.find((p) =>
    selected.path
      ? p.path === selected.path
      : parseSaleEntity(p.content).title === selected.name ||
        p.path.split("/").at(-1)?.replace(/\.md$/, "") === selected.name,
  );
  if (!root)
    throw new AppError(
      422,
      "必须先读取并核实所选产品页；自定义产品名称无法定位时，请补充准确的知识库产品路径",
    );
  for (const e of item.evidence) {
    const [page] = await db.query<{
      id: string;
      path: string;
      content: string;
    }>("SELECT id,path,content FROM snapshots WHERE id=$1 AND project_id=$2", [
      e.snapshotId,
      projectId,
    ]);
    if (!page) continue;
    const entity = parseSaleEntity(page.content);
    if (item.sales.includes(entity.title))
      await validateCatalogSale(
        db,
        projectId,
        { ...selected, path: root.path },
        page,
        item.version,
      );
  }
  if (
    item.productScopeRevision !== undefined &&
    item.productScopeRevision !== scope.revision
  )
    throw new AppError(409, "产品选型版本已更新，请重新读取项目状态");
  return scope.revision;
}
