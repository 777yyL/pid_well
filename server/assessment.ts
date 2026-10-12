import type { Database } from "./db.js";
import { audit } from "./db.js";
import { AppError } from "./errors.js";
import {
  assessmentSchema,
  requirementSchema,
  type AssessmentInput,
  type RequirementInput,
} from "../shared/domain.js";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { parseSaleEntity } from "./sale-entity.js";
import { enforceProductScope } from "./product-scope.js";
export function checkOriginal(requirement: RequirementInput, lines: string[]) {
  if (
    requirement.lineEnd < requirement.lineStart ||
    requirement.lineEnd > lines.length
  )
    throw new AppError(422, `${requirement.id} 原文行号超出范围`);
  const span = lines
    .slice(requirement.lineStart - 1, requirement.lineEnd)
    .join("\n");
  if (!span.includes(requirement.raw))
    throw new AppError(422, `${requirement.id} 内容必须逐字引用指定行号的原文`);
}
export async function saveRequirements(
  db: Database,
  projectId: string,
  input: unknown,
  runId: string | null,
) {
  const items = requirementSchema.array().min(1).max(500).parse(input);
  if (new Set(items.map((i) => i.id)).size !== items.length)
    throw new AppError(422, "要求编号不能重复");
  await db.transaction(async (tx) => {
    for (const item of items) {
      const [doc] = await tx.query<{ lines: string[] }>(
        "SELECT lines FROM documents WHERE id=$1 AND project_id=$2 AND status=$3",
        [item.documentId, projectId, "ready"],
      );
      if (!doc) throw new AppError(422, "要求必须来自本项目已解析的文档");
      checkOriginal(item, doc.lines);
      const [existing] = await tx.query<{
        data: RequirementInput;
        confirmed: boolean;
      }>(
        "SELECT data,confirmed FROM requirements WHERE project_id=$1 AND id=$2 FOR UPDATE",
        [projectId, item.id],
      );
      if (existing?.confirmed && !isDeepStrictEqual(existing.data, item))
        throw new AppError(
          409,
          `${item.id} 已经人工确认，不可被 Agent 修改；请使用新的编号或新建评估项目`,
        );
      await tx.query(
        "INSERT INTO requirements(id,project_id,data) VALUES($1,$2,$3) ON CONFLICT(project_id,id) DO UPDATE SET data=EXCLUDED.data WHERE requirements.confirmed=false",
        [item.id, projectId, JSON.stringify(item)],
      );
    }
    await audit(tx, projectId, null, runId, "requirements_saved", {
      ids: items.map((i) => i.id),
    });
  });
  return { count: items.length, requiresConfirmation: true };
}
export function checkVerdict(item: AssessmentInput) {
  if (
    item.level === "exact" &&
    (item.no.length ||
      item.hard.length ||
      !item.sales.length ||
      !item.evidence.length)
  )
    throw new AppError(
      422,
      "完全满足必须有销售项和证据，且不能有不满足或需定制的能力",
    );
  if (
    item.level !== "no_match" &&
    (!item.sales.length || !item.evidence.length)
  )
    throw new AppError(422, "匹配结论必须有销售项和原始知识库证据");
  if (item.level === "partial" && !item.hard.length && !item.no.length)
    throw new AppError(422, "部分满足必须列出具体缺口");
  if (item.level === "no_match" && !item.no.length)
    throw new AppError(422, "不满足必须列出不具备的能力");
}
export async function validateEvidence(
  db: Database,
  projectId: string,
  item: AssessmentInput,
) {
  const salesTitles = new Set<string>();
  for (const evidence of item.evidence) {
    const [snapshot] = await db.query<{ content: string; path: string }>(
      "SELECT content,path FROM snapshots WHERE id=$1 AND project_id=$2",
      [evidence.snapshotId, projectId],
    );
    if (!snapshot)
      throw new AppError(422, "证据必须引用本项目读取过的知识库快照");
    const lines = snapshot.content.split(/\r?\n/);
    if (
      evidence.lineEnd < evidence.lineStart ||
      evidence.lineEnd > lines.length ||
      !lines
        .slice(evidence.lineStart - 1, evidence.lineEnd)
        .join("\n")
        .includes(evidence.quote)
    )
      throw new AppError(422, "知识库证据摘录或行号不准确");
    const meta = parseSaleEntity(snapshot.content);
    if (meta.title && (meta.moduleId || snapshot.path.includes("/sale-items/")))
      salesTitles.add(meta.title);
  }
  for (const sale of item.sales)
    if (!salesTitles.has(sale))
      throw new AppError(
        422,
        `销售项「${sale}」必须有正式实体页 title 对应的证据，不能使用组件名称`,
      );
}
export async function saveAssessments(
  db: Database,
  projectId: string,
  input: unknown,
  actor: { userId?: string; runId?: string; human?: boolean },
) {
  const items = assessmentSchema.array().min(1).max(100).parse(input);
  if (new Set(items.map((i) => i.requirementId)).size !== items.length)
    throw new AppError(422, "同一批不能重复写入相同要求");
  const versions: { requirementId: string; revision: number }[] = [];
  await db.transaction(async (tx) => {
    const stages = await tx.query<{ kind: string }>(
      "SELECT DISTINCT kind FROM snapshots WHERE project_id=$1",
      [projectId],
    );
    if (
      !actor.human &&
      (!stages.some((s) => s.kind === "overview") ||
        !stages.some((s) => s.kind === "product"))
    )
      throw new AppError(422, "必须先读取知识库总览和产品页再保存匹配");
    for (const item of items) {
      checkVerdict(item);
      const scopeRevision = await enforceProductScope(tx, projectId, item);
      if (scopeRevision) item.productScopeRevision = scopeRevision;
      const [requirement] = await tx.query<{ confirmed: boolean }>(
        "SELECT confirmed FROM requirements WHERE project_id=$1 AND id=$2",
        [projectId, item.requirementId],
      );
      if (!requirement) throw new AppError(422, "要求编号不存在");
      if (!requirement.confirmed)
        throw new AppError(409, "要求尚未确认，请先由用户确认抽取条款");
      await validateEvidence(tx, projectId, item);
      const [previous] = await tx.query<{
        source: string;
        revision: number;
        data: AssessmentInput;
      }>(
        "SELECT source,revision,data FROM assessments WHERE project_id=$1 AND requirement_id=$2 FOR UPDATE",
        [projectId, item.requirementId],
      );
      if (previous?.source === "human" && !actor.human)
        throw new AppError(
          409,
          "人工确认结果不可被 Agent 覆盖；请向用户说明新的发现",
        );
      const [saved] = await tx.query<{ revision: number }>(
        `INSERT INTO assessments(id,project_id,requirement_id,data,source,reviewed) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(project_id,requirement_id) DO UPDATE SET data=EXCLUDED.data,source=EXCLUDED.source,reviewed=EXCLUDED.reviewed,revision=assessments.revision+1,updated_at=now() WHERE assessments.source<>'human' OR EXCLUDED.source='human' RETURNING revision`,
        [
          randomUUID(),
          projectId,
          item.requirementId,
          JSON.stringify(item),
          actor.human ? "human" : "agent",
          !!actor.human,
        ],
      );
      versions.push({
        requirementId: item.requirementId,
        revision: saved.revision,
      });
      await audit(
        tx,
        projectId,
        actor.userId ?? null,
        actor.runId ?? null,
        actor.human ? "human_assessment" : "agent_assessment",
        {
          requirementId: item.requirementId,
          before: previous?.data ?? null,
          after: item,
        },
      );
    }
  });
  return { saved: items.map((i) => i.requirementId), versions };
}
export async function assessmentRows(
  db: Database,
  projectId: string,
  limit = 10000,
  offset = 0,
  filters: { ids?: string[]; unreviewed?: boolean } = {},
) {
  const rows = await db.query<{
    id: string;
    data: AssessmentInput;
    source: "human" | "agent";
    reviewed: boolean;
    revision: number;
    requirement_raw: string;
    module: string;
  }>(
    `SELECT a.id,a.data,a.source,a.reviewed,a.revision,r.data->>'raw' AS requirement_raw,r.data->>'module' AS module FROM assessments a JOIN requirements r ON r.project_id=a.project_id AND r.id=a.requirement_id WHERE a.project_id=$1 AND ($4::text[] IS NULL OR a.requirement_id=ANY($4::text[])) AND (NOT $5::boolean OR a.reviewed=false) ORDER BY split_part(a.requirement_id,'-',2)::bigint,a.requirement_id LIMIT $2 OFFSET $3`,
    [projectId, limit, offset, filters.ids ?? null, !!filters.unreviewed],
  );
  return rows.map(({ data, ...rest }) => ({ ...data, ...rest }));
}
