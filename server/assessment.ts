import { projectKnowledge } from "./structured-knowledge.js";
import type { Database } from "./db.js";
import { audit } from "./db.js";
import { AppError } from "./errors.js";
import {
  assessmentSchema,
  requirementSchema,
  subRequirementSchema,
  type AssessmentInput,
  type RequirementInput,
} from "../shared/domain.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { parseSaleEntity } from "./sale-entity.js";
import { enforceProductScope } from "./product-scope.js";
import {
  aggregateVerdict,
  selectedContributions,
  assessmentEvidence,
} from "../shared/accuracy.js";
import { validateCatalogSale, resolveProductPage } from "./product-search.js";
import { productScope } from "./product-scope.js";
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
      if (item.subrequirements) {
        if (
          new Set(item.subrequirements.map((s) => s.id)).size !==
          item.subrequirements.length
        )
          throw new AppError(422, "子要求编号不能重复");
        for (const sub of item.subrequirements) {
          if (
            sub.lineStart < item.lineStart ||
            sub.lineEnd > item.lineEnd ||
            !item.raw.includes(sub.raw)
          )
            throw new AppError(422, "子要求必须逐字定位父条款原文");
          checkOriginal({ ...item, ...sub }, doc.lines);
        }
      }
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
export const supplementSchema = z.object({
  expectedSubrequirements: z.array(subRequirementSchema).nullable(),
  subrequirements: z.array(subRequirementSchema).min(1).max(100),
});
export async function supplementSubrequirements(
  db: Database,
  projectId: string,
  requirementId: string,
  userId: string,
  input: unknown,
) {
  const value = supplementSchema.parse(input);
  return db.transaction(async (tx) => {
    const [row] = await tx.query<{
      data: RequirementInput;
      confirmed: boolean;
    }>(
      "SELECT data,confirmed FROM requirements WHERE project_id=$1 AND id=$2 FOR UPDATE",
      [projectId, requirementId],
    );
    if (!row?.confirmed) throw new AppError(409, "请先确认父条款原文");
    if (
      !isDeepStrictEqual(
        row.data.subrequirements ?? null,
        value.expectedSubrequirements,
      )
    )
      throw new AppError(409, "子要求已更新，请刷新后重新核对");
    if (
      row.data.subrequirements?.length &&
      !isDeepStrictEqual(row.data.subrequirements, value.subrequirements)
    )
      throw new AppError(
        409,
        "已确认子要求不能替换；补全入口仅用于缺少子要求的历史条款",
      );
    if (
      new Set(value.subrequirements.map((s) => s.id)).size !==
      value.subrequirements.length
    )
      throw new AppError(422, "子要求编号不能重复");
    const [doc] = await tx.query<{ lines: string[] }>(
      "SELECT lines FROM documents WHERE project_id=$1 AND id=$2 AND status='ready'",
      [projectId, row.data.documentId],
    );
    if (!doc) throw new AppError(422, "父条款原文文档不可用");
    for (const sub of value.subrequirements) {
      if (
        sub.lineStart < row.data.lineStart ||
        sub.lineEnd > row.data.lineEnd ||
        !row.data.raw.includes(sub.raw)
      )
        throw new AppError(422, "子要求必须逐字定位父条款原文");
      checkOriginal({ ...row.data, ...sub }, doc.lines);
    }
    const updated = { ...row.data, subrequirements: value.subrequirements };
    await tx.query(
      "UPDATE requirements SET data=$1 WHERE project_id=$2 AND id=$3",
      [JSON.stringify(updated), projectId, requirementId],
    );
    await audit(
      tx,
      projectId,
      userId,
      null,
      "subrequirements_human_confirmed",
      {
        requirementId,
        before: row.data.subrequirements ?? null,
        after: value.subrequirements,
        assessmentPreserved: true,
      },
    );
    return { ...updated, confirmed: row.confirmed };
  });
}
export function checkVerdict(item: AssessmentInput) {
  if (
    item.level === "exact" &&
    (item.no.length ||
      item.hard.length ||
      (!item.sales.length &&
        !item.verification?.contributions.some(
          (c) => c.purpose === "existing",
        )) ||
      !item.evidence.length)
  )
    throw new AppError(
      422,
      "完全满足必须有销售项和证据，且不能有不满足或需定制的能力",
    );
  if (
    ["exact", "partial"].includes(item.level) &&
    ((!item.sales.length &&
      !item.verification?.contributions.some(
        (c) => c.purpose === "existing",
      )) ||
      !item.evidence.length)
  )
    throw new AppError(422, "匹配结论必须有销售项和原始知识库证据");
  if (item.level === "partial" && !item.hard.length && !item.no.length)
    throw new AppError(422, "部分满足必须列出具体缺口");
  if (item.level === "no_match" && (!item.no.length || !item.evidence.length))
    throw new AppError(422, "不满足必须列出明确反向证据，资料缺失应为待确认");
}
export async function validateVerification(
  db: Database,
  projectId: string,
  item: AssessmentInput,
  requirement: RequirementInput,
) {
  const v = item.verification;
  if (!v) {
    throw new AppError(422, "新评估必须提供核验结论与证据，可按原条款整体评估");
  }
  const checkIds = new Set(v.checks.map((c) => c.subrequirementId));
  if (checkIds.size !== v.checks.length)
    throw new AppError(422, "核验项编号不能重复");
  if (new Set(v.contributions.map((c) => c.id)).size !== v.contributions.length)
    throw new AppError(422, "贡献项编号不能重复");
  const scope = await productScope(db, projectId);
  const knowledge = await projectKnowledge(db, projectId);
  const entities = new Map<string, ReturnType<typeof parseSaleEntity>>();
  for (const c of v.contributions) {
    const selected = scope.selected.find(
      (p) =>
        p.name === c.product &&
        p.version.replace(/^v/i, "") === c.version.replace(/^v/i, ""),
    );
    if (!selected) throw new AppError(422, "贡献项产品/版本不在确认范围");
    const root = await resolveProductPage(db, projectId, selected);
    if (!root) throw new AppError(422, "贡献项产品页尚未读取");
    if (c.subrequirementIds.some((id) => !checkIds.has(id)))
      throw new AppError(422, "贡献项关联了本次未提供的核验项");
    let found = false;
    for (const e of c.evidence) {
      const [page] = await db.query<{
        id: string;
        path: string;
        content: string;
      }>(
        "SELECT id,path,content FROM snapshots WHERE project_id=$1 AND id=$2",
        [projectId, e.snapshotId],
      );
      if (page?.path === c.path) {
        const entity = parseSaleEntity(page.content);
        if (entity.saleItemId) {
          if (
            (c.saleItemId && c.saleItemId !== entity.saleItemId) ||
            (c.knowledgeReleaseId &&
              c.knowledgeReleaseId !== entity.knowledgeReleaseId)
          )
            throw new AppError(422, "贡献项销售项ID或发布版本与证据不一致");
          c.saleItemId = entity.saleItemId;
          c.knowledgeReleaseId = entity.knowledgeReleaseId;
        } else if (c.saleItemId || c.knowledgeReleaseId)
          throw new AppError(422, "Wiki历史证据不能声明结构化销售项ID");
        entities.set(c.id, entity);
        if (entity.title !== c.sales || entity.moduleId !== c.moduleId)
          throw new AppError(422, "贡献项标识与实体不一致");
        await validateCatalogSale(
          db,
          projectId,
          { ...selected, path: root.path },
          page,
          c.version,
        );
        found = true;
      }
    }
    if (!found) throw new AppError(422, "贡献项必须引用指定正式实体页");
  }
  for (const c of v.contributions.filter((c) => c.reuseOf)) {
    const target = v.contributions.find((other) => other.id === c.reuseOf);
    if (
      c.purpose !== "existing" ||
      !target ||
      target.id === c.id ||
      target.reuseOf ||
      !["purchase", "dependency", "existing"].includes(target.purpose)
    )
      throw new AppError(
        422,
        "组件复用必须由已有授权项指向本条款中明确选用的来源贡献项，不能循环复用",
      );
    if (
      (target.product !== c.product ||
        target.version !== c.version ||
        target.path !== c.path ||
        target.moduleId !== c.moduleId) &&
      !v.integrations.some(
        (i) =>
          i.confirmed &&
          i.evidence.length &&
          i.authorization.trim() &&
          ((i.from === c.id && i.to === target.id) ||
            (i.to === c.id && i.from === target.id)),
      )
    )
      throw new AppError(
        422,
        "组件复用需要已确认的集成与授权证据，不能仅凭同名认定共享",
      );
  }
  for (const c of v.contributions.filter((c) => c.purpose === "dependency")) {
    const entity = entities.get(c.id)!;
    if (
      !/^(?:是|true|必选)$/i.test(entity.mandatory) &&
      !v.contributions.some(
        (other) =>
          other.id !== c.id &&
          ["purchase", "dependency", "existing"].includes(other.purpose) &&
          ((other.product === c.product && other.version === c.version) ||
            (!!entities.get(other.id)?.knowledgeReleaseId &&
              entities.get(other.id)?.knowledgeReleaseId ===
                entities.get(c.id)?.knowledgeReleaseId &&
              entities.get(other.id)?.dependencies.includes(c.path))) &&
          entities
            .get(other.id)
            ?.dependencies.some((d) =>
              [
                c.sales,
                c.moduleId,
                c.path,
                c.path.replace(/\.md$/, ""),
                c.path.split("/").at(-1)?.replace(/\.md$/, ""),
              ].includes(d),
            ),
      )
    )
      throw new AppError(422, "正式依赖必须由选用实体的依赖关系或必选声明支持");
  }
  for (const check of v.checks) {
    const required =
      requirement.subrequirements?.find((s) => s.id === check.subrequirementId)
        ?.required ?? true;
    if (["exact", "no_match"].includes(check.level) && !check.evidence.length)
      throw new AppError(422, "明确结论需要逐子要求证据");
    if (
      check.level === "exact" &&
      !v.contributions.some(
        (c) =>
          (!required ||
            (c.purpose !== "candidate" && c.purpose !== "optional")) &&
          c.subrequirementIds.includes(check.subrequirementId),
      )
    )
      throw new AppError(422, "满足的子要求缺少选用贡献项");
    for (const e of check.evidence) {
      if (
        ["exact", "no_match"].includes(check.level) &&
        !v.contributions.some(
          (c) =>
            (check.level !== "exact" ||
              !required ||
              (c.purpose !== "candidate" && c.purpose !== "optional")) &&
            c.subrequirementIds.includes(check.subrequirementId) &&
            c.evidence.some((proof) => proof.snapshotId === e.snapshotId),
        )
      )
        throw new AppError(
          422,
          "明确子要求证据必须来自范围内关联贡献项，满足项不得仅引用候选",
        );
      const [page] = await db.query<{ content: string }>(
        "SELECT content FROM snapshots WHERE project_id=$1 AND id=$2",
        [projectId, e.snapshotId],
      );
      if (check.level === "exact" && page) {
        const entityId = parseSaleEntity(page.content).saleItemId;
        const sale = knowledge?.data.saleItems.find(
          (s) => s.sale_item_id === entityId,
        );
        if (sale && !sale.specification_md?.trim())
          throw new AppError(
            422,
            `销售项 ${sale.name}（${sale.sale_item_id}）技术规格待确认，不能作为完全满足的能力证据`,
          );
        const front = page.content.match(/^---\r?\n[\s\S]*?\r?\n---/);
        const frontLines = front?.[0].split(/\r?\n/).length ?? 0;
        const bodyQuote = e.quote
          .split(/\r?\n/)
          .filter((s) => s.trim() && !/^\s*#/.test(s));
        const capabilitySpan = page.content
          .split(/\r?\n/)
          .slice(Math.max(frontLines, e.lineStart - 1), e.lineEnd)
          .join("\n");
        if (
          !capabilitySpan.includes(e.quote) ||
          !bodyQuote.length ||
          e.quote.trim() === parseSaleEntity(page.content).title
        )
          throw new AppError(422, "标题或元数据不能替代能力证据");
      }
    }
  }
  for (const search of v.supplementalSearch) {
    const [trace] = await db.query<{
      data: {
        requirementId: string;
        subrequirementId?: string;
        query: string;
        scopeRevision: number;
      };
    }>(
      "SELECT data FROM audit_log WHERE project_id=$1 AND id=$2 AND action IN ('product_scoped_search','product_global_search')",
      [projectId, search.traceId],
    );
    if (
      !trace ||
      trace.data.requirementId !== item.requirementId ||
      trace.data.query !== search.query ||
      trace.data.scopeRevision !== scope.revision
    )
      throw new AppError(422, "补充检索轨迹不存在、范围已变化或不属于当前条款");
  }
  for (const i of v.integrations)
    if (
      !v.contributions.some((c) => c.id === i.from) ||
      !v.contributions.some((c) => c.id === i.to) ||
      i.from === i.to
    )
      throw new AppError(422, "联动必须关联不同贡献项");
  if (
    new Set(
      v.contributions
        .filter((c) => c.purpose !== "candidate" && c.purpose !== "optional")
        .map((c) => c.product),
    ).size > 1 &&
    !v.integrationRequired
  )
    throw new AppError(422, "跨产品组合必须显式核验联动条件");
  if (aggregateVerdict(item, requirement) !== item.level)
    throw new AppError(422, "顶层结论与必需子要求/交付/集成条件不一致");
  const names = selectedContributions(item).map((c) => c.sales);
  if (
    item.sales.some((s) => !names.includes(s)) ||
    names.some((s) => !item.sales.includes(s))
  )
    throw new AppError(
      422,
      "sales 只能列最终采购或正式依赖，候选/已有授权/可选增强须单列",
    );
}
export async function validateEvidence(
  db: Database,
  projectId: string,
  item: AssessmentInput,
) {
  const salesTitles = new Set<string>();
  const allEvidence = assessmentEvidence(item);
  for (const evidence of allEvidence) {
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
      const release = await projectKnowledge(tx, projectId);
      if (item.knowledgeReleaseId && item.knowledgeReleaseId !== release?.id)
        throw new AppError(422, "评估引用的知识发布版本与项目固定版本不一致");
      if (release) item.knowledgeReleaseId = release.id;
      checkVerdict(item);
      const scopeRevision = await enforceProductScope(tx, projectId, item);
      if (scopeRevision) item.productScopeRevision = scopeRevision;
      const [requirement] = await tx.query<{
        confirmed: boolean;
        data: RequirementInput;
      }>(
        "SELECT confirmed,data FROM requirements WHERE project_id=$1 AND id=$2",
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
      // Historical human records remain editable without pretending they acquired v2 verification.
      if (!(
        actor.human &&
        previous &&
        !previous.data.verification &&
        !item.verification
      ))
        await validateVerification(tx, projectId, item, requirement.data);
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
