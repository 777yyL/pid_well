import { z } from "zod";
import type { Database } from "./db.js";
import { audit } from "./db.js";
import { AppError } from "./errors.js";
import { parseSaleEntity } from "./sale-entity.js";
import {
  productCandidateSchema,
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
  return (
    row ?? {
      revision: 1,
      status: "pending",
      recommendations: [],
      selected: [],
      strategy: "",
      confirmed_by: null,
    }
  );
}
export async function recommendProducts(
  db: Database,
  projectId: string,
  input: unknown,
  runId: string,
) {
  const candidates = productCandidateSchema.array().min(1).max(20).parse(input);
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
    for (const candidate of candidates)
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
    await tx.query(
      "INSERT INTO product_scopes(project_id,recommendations) VALUES($1,$2) ON CONFLICT(project_id) DO UPDATE SET recommendations=EXCLUDED.recommendations,revision=product_scopes.revision+1,updated_at=now()",
      [projectId, JSON.stringify(candidates)],
    );
    await audit(tx, projectId, null, runId, "products_recommended", {
      candidates,
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
    const [scope] = await tx.query<{ revision: number }>(
      "SELECT revision FROM product_scopes WHERE project_id=$1 FOR UPDATE",
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
    if (existing)
      throw new AppError(
        409,
        "已有匹配结果，不能切换产品范围；请新建项目比较另一种售前策略",
      );
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
      (!p.version ||
        p.version.replace(/^v/, "") === item.version.replace(/^v/, "")),
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
  const allowed = new Set(
    scope.selected.flatMap((p) =>
      [p.name, p.path.split("/").at(-1)?.replace(/\.md$/, "")].filter(Boolean),
    ),
  );
  for (const e of item.evidence) {
    const [page] = await db.query<{ content: string }>(
      "SELECT content FROM snapshots WHERE id=$1 AND project_id=$2",
      [e.snapshotId, projectId],
    );
    if (!page) continue;
    const entity = parseSaleEntity(page.content);
    if (
      item.sales.includes(entity.title) &&
      entity.product &&
      !allowed.has(entity.product)
    )
      throw new AppError(
        422,
        "销售项实体所属产品不在已确认范围内，不能将其它产品能力混入当前评估",
      );
  }
  if (
    item.productScopeRevision !== undefined &&
    item.productScopeRevision !== scope.revision
  )
    throw new AppError(409, "产品选型版本已更新，请重新读取项目状态");
  return scope.revision;
}
