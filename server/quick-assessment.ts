import { loadSemanticSettings } from "./semantic-settings.js";
import { prepareSemanticCatalog } from "./semantic-catalog.js";
import { config } from "./config.js";
import { runEvidencePipeline } from "./assessment-pipeline.js";
import {
  loadCatalogContext,
  selectCatalogPackets,
  type CatalogSelector,
} from "./catalog-context.js";
import { isTransientFailure } from "./run-recovery.js";
import { z } from "zod";
import {
  type RequirementInput,
  type AssessmentInput,
  type ProductScope,
  verificationSchema,
  assessmentSchema,
} from "../shared/domain.js";
import { aggregateVerdict } from "../shared/accuracy.js";
import type { Database } from "./db.js";
import { productScope } from "./product-scope.js";
import {
  searchSelected,
  searchGlobalFallback,
  prepareSelectedSearch,
} from "./product-search.js";
import { checkOriginal, saveAssessments } from "./assessment.js";
import { audit } from "./db.js";
import { AppError } from "./errors.js";

export interface QuickPacket {
  alternativeNote?: string;
  requirement: RequirementInput;
  candidates: {
    path: string;
    snapshotId: string;
    sales: string;
    moduleId: string;
    product: string;
    version: string;
    saleItemId?: string;
    knowledgeReleaseId?: string;
    excerpts: {
      lineStart: number;
      lineEnd: number;
      quote: string;
      truncated?: boolean;
    }[];
  }[];
  searches: { subrequirementId: string; query: string; traceId: number }[];
}
// Send each immutable entity body once per request, even when many clauses use it.
export function judgmentPayload(packets: QuickPacket[]) {
  const evidence = Object.fromEntries(
    packets.flatMap((p) => p.candidates.map((c) => [c.snapshotId, c.excerpts])),
  );
  return {
    evidence,
    requirements: packets.map((p) => ({
      ...p,
      candidates: p.candidates.map(({ excerpts, ...candidate }) => candidate),
    })),
  };
}
const proof = z.object({
  candidateIndex: z.number().int().nonnegative(),
  lineStart: z.number().int().positive(),
  lineEnd: z.number().int().positive(),
  quote: z.string().min(1),
});
const judgment = z.object({
  selfReview: assessmentSchema.shape.selfReview,
  requirementId: z.string(),
  selections: z.array(
    z.object({
      candidateIndex: z.number().int().nonnegative(),
      purpose: z.enum([
        "purchase",
        "dependency",
        "existing",
        "optional",
        "candidate",
      ]),
      reason: z.string().min(1),
    }),
  ),
  checks: z
    .array(
      verificationSchema.shape.checks.element.omit({ evidence: true }).extend({
        evidence: z.array(proof),
        quantitative: verificationSchema.shape.checks.element.shape.quantitative
          .unwrap()
          .extend({
            actualValue: z
              .number()
              .nullish()
              .transform((value) => value ?? undefined),
            actualUnit: z
              .string()
              .nullish()
              .transform((value) => value ?? undefined),
          })
          .optional(),
      }),
    )
    .min(1),
});
export function parseQuickJudgments(raw: unknown, expected: string[]) {
  const parsed = z
    .object({ assessments: z.array(judgment) })
    .parse(
      typeof raw === "string"
        ? JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, ""))
        : raw,
    ).assessments;
  if (
    parsed.length !== expected.length ||
    new Set(parsed.map((x) => x.requirementId)).size !== expected.length ||
    parsed.some((x) => !expected.includes(x.requirementId))
  )
    throw new Error("批次条款必须完整且唯一");
  return parsed;
}
export function planQuickBatches(
  packets: QuickPacket[],
  budget: number,
  maxItems = 5,
) {
  const batches: QuickPacket[][] = [];
  for (const p of packets) {
    if (JSON.stringify(judgmentPayload([p])).length > budget)
      throw new Error(
        `条款 ${p.requirement.id} 超过单批上下文预算，请使用深度评估`,
      );
    const last = batches.at(-1);
    if (
      !last ||
      last.length >= maxItems ||
      JSON.stringify(judgmentPayload([...last, p])).length > budget
    )
      batches.push([p]);
    else last.push(p);
  }
  return batches;
}
export function buildQuickAssessment(
  packet: QuickPacket,
  value: z.infer<typeof judgment>,
  primary: ProductScope["selected"][number],
): AssessmentInput {
  const candidate = (index: number) => {
    const c = packet.candidates[index];
    if (!c) throw new Error("引用不存在的候选销售项");
    return c;
  };
  const evidence = (p: z.infer<typeof proof>) => ({
    snapshotId: candidate(p.candidateIndex).snapshotId,
    lineStart: p.lineStart,
    lineEnd: p.lineEnd,
    quote: p.quote,
  });
  const checks = value.checks.map((c) => ({
    ...c,
    evidence: c.evidence.map(evidence),
  }));
  const contributions = value.selections.map((s) => {
    const c = candidate(s.candidateIndex);
    return {
      id: `c-${s.candidateIndex}`,
      product: c.product,
      version: c.version,
      sales: c.sales,
      path: c.path,
      moduleId: c.moduleId,
      capability: s.reason,
      purpose: s.purpose,
      reason: s.reason,
      saleItemId: c.saleItemId,
      knowledgeReleaseId: c.knowledgeReleaseId,
      subrequirementIds: value.checks
        .filter((x) =>
          x.evidence.some((e) => e.candidateIndex === s.candidateIndex),
        )
        .map((x) => x.subrequirementId),
      evidence: value.checks.flatMap((x) =>
        x.evidence
          .filter((e) => e.candidateIndex === s.candidateIndex)
          .map(evidence),
      ),
    };
  });
  const selected = contributions.filter((c) =>
    ["purchase", "dependency", "existing"].includes(c.purpose),
  );
  const pending = "快速初评，未经独立复核，需人工核对";
  const item: AssessmentInput = {
    selfReview: value.selfReview,
    requirementId: packet.requirement.id,
    product: primary.name,
    version: primary.version,
    sales: contributions
      .filter((c) => ["purchase", "dependency"].includes(c.purpose))
      .map((c) => c.sales),
    level: "unknown",
    ok: checks.filter((c) => c.level === "exact").map((c) => c.reason),
    hard: checks.filter((c) => c.level === "partial").map((c) => c.reason),
    no: checks.filter((c) => c.level === "no_match").map((c) => c.reason),
    note: value.selfReview?.completed
      ? "首次判断已包含AI自检；存在专项风险的条款仍需复核，未经独立或人工复核"
      : pending,
    criteria: {
      direction: checks.map((c) => c.direction).join("；"),
      scope: "已确认产品版本范围内",
      spec: checks.map((c) => c.reason).join("；"),
      context: packet.requirement.module,
      delivery: checks.map((c) => c.delivery).join("、"),
    },
    evidence: checks.flatMap((c) => c.evidence),
    dependencies: [],
    mustSelect: [],
    verification: {
      version: 2,
      checks,
      contributions,
      integrationRequired: new Set(selected.map((c) => c.product)).size > 1,
      integrations: [],
      supplementalSearch: checks
        .filter((c) => ["unknown", "no_match"].includes(c.level))
        .flatMap((c) => {
          const s =
            packet.searches.findLast(
              (x) => x.subrequirementId === c.subrequirementId,
            ) ?? packet.searches.at(-1);
          return s
            ? [
                {
                  ...s,
                  subrequirementId: c.subrequirementId,
                  outcome: c.reason,
                },
              ]
            : [];
        }),
      counterchecks: {
        direction: value.selfReview?.checks.direction ?? pending,
        omissions: value.selfReview?.checks.scope ?? pending,
        quantitative: value.selfReview?.checks.spec ?? pending,
        external: value.selfReview?.checks.delivery ?? pending,
        integration: value.selfReview?.checks.context ?? pending,
      },
    },
  };
  item.level = aggregateVerdict(item, packet.requirement);
  return item;
}

export async function runQuickAssessment(
  db: Database,
  projectId: string,
  runId: string,
  signal: AbortSignal,
  judge: (
    packets: QuickPacket[],
    feedback?: string,
    requestSignal?: AbortSignal,
  ) => Promise<string>,
  emit: (payload: Record<string, unknown>) => Promise<void>,
  budget = 60000,
  select?: CatalogSelector,
  batchSize = 5,
) {
  const scope = await productScope(db, projectId);
  if (scope.status !== "confirmed" || !scope.selected.length) return false;
  const rows = await db.transaction(async (tx) => {
    await tx.query("SELECT id FROM projects WHERE id=$1 FOR UPDATE", [
      projectId,
    ]);
    const rows = await tx.query<{ data: RequirementInput; confirmed: boolean }>(
      "SELECT data,confirmed FROM requirements WHERE project_id=$1 ORDER BY id FOR UPDATE",
      [projectId],
    );
    for (const row of rows) {
      if (row.confirmed && row.data.subrequirements?.length) continue;
      const [human] = await tx.query(
        "SELECT id FROM assessments WHERE project_id=$1 AND requirement_id=$2 AND source='human'",
        [projectId, row.data.id],
      );
      if (human) continue;
      const [doc] = await tx.query<{ lines: string[]; status: string }>(
        "SELECT lines,status FROM documents WHERE project_id=$1 AND id=$2",
        [projectId, row.data.documentId],
      );
      if (!doc || doc.status !== "ready") continue;
      checkOriginal(row.data, doc.lines);
      row.data = {
        ...row.data,
        extractionMode: "quick",
        subrequirements: row.data.subrequirements?.length
          ? row.data.subrequirements
          : [
              {
                id: row.data.id + ".1",
                raw: row.data.raw,
                required: true,
                lineStart: row.data.lineStart,
                lineEnd: row.data.lineEnd,
              },
            ],
      };
      row.confirmed = true;
      await tx.query(
        "UPDATE requirements SET data=$1,confirmed=true WHERE project_id=$2 AND id=$3",
        [JSON.stringify(row.data), projectId, row.data.id],
      );
      await audit(tx, projectId, null, runId, "quick_requirements_prepared", {
        requirementId: row.data.id,
        source: "automatic",
      });
    }
    return rows;
  });
  if (
    !rows.length ||
    rows.some((r) => !r.confirmed || !r.data.subrequirements?.length)
  )
    return false;
  const documents = await db.query<{ id: string }>(
    "SELECT id FROM documents WHERE project_id=$1 AND status='ready'",
    [projectId],
  );
  if (documents.some((d) => !rows.some((r) => r.data.documentId === d.id)))
    return false;
  const saved = await db.query<{
    requirement_id: string;
    source: string;
    data: AssessmentInput;
  }>("SELECT requirement_id,source,data FROM assessments WHERE project_id=$1", [
    projectId,
  ]);
  const pending = rows.filter(
    (r) =>
      !saved.some(
        (a) =>
          a.requirement_id === r.data.id &&
          (a.source === "human" ||
            a.data.productScopeRevision === scope.revision),
      ),
  );
  const counters = {
    total: rows.length,
    retrieved: 0,
    judged: 0,
    saved: rows.length - pending.length,
    failed: 0,
  };
  const cache = new Map<string, Promise<Record<string, unknown>>>();
  const started = Date.now();
  const failures: {
    requirementIds: string[];
    stage: string;
    message: string;
    attempt: number;
    retryable: boolean;
    at: string;
  }[] = [];
  const terminalErrors: unknown[] = [];
  const judged = new Set<string>();
  const activeRetrievals = new Map<string, number>();
  let batchStage = "",
    batchMessage = "";
  let displayMessage = "",
    stageStartedAt = started;
  const progress = async (stage: string, message: string) => {
    const display = batchMessage || message;
    if (displayMessage !== display) {
      displayMessage = display;
      stageStartedAt = Date.now();
    }
    await emit({
      ...counters,
      stage: batchStage || stage,
      message: display,
      stageStartedAt,
      failures: [...failures],
      activeRetrievals: [...activeRetrievals].map(([id, at]) => ({
        requirementId: id,
        startedAt: at,
      })),
      elapsedMs: Date.now() - started,
    });
  };
  const invokeJudge = async (
    batch: QuickPacket[],
    feedback: string | undefined,
    requestSignal: AbortSignal,
  ) => {
    const at = Date.now();
    let ok = false,
      errorMessage = "";
    try {
      const result = await judge(batch, feedback, requestSignal);
      ok = true;
      return result;
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      await audit(db, projectId, null, runId, "quick_model_request", {
        requirementIds: batch.map((p) => p.requirement.id),
        inputChars: JSON.stringify(judgmentPayload(batch)).length,
        elapsedMs: Date.now() - at,
        ok,
        error: errorMessage.slice(0, 2000),
        retry: !!feedback,
      });
    }
  };
  const failure = async (
    ids: string[],
    stage: string,
    error: unknown,
    attempt = 1,
    retryable = false,
  ) => {
    const detail = {
      requirementIds: ids,
      stage,
      message: (error instanceof Error ? error.message : String(error)).slice(
        0,
        2000,
      ),
      attempt,
      retryable,
      at: new Date().toISOString(),
    };
    failures.push(detail);
    await progress(
      "failed",
      `${ids.join("、")} ${stage}失败：${detail.message}`,
    );
    return detail.message;
  };
  await progress("retrieving", "正在准备本次任务的产品目录与版本范围");
  const context =
    pending.length && select
      ? await loadCatalogContext(db, projectId, runId, signal)
      : undefined;
  let semantic: Awaited<ReturnType<typeof prepareSemanticCatalog>> | undefined;
  const semanticSettings = await loadSemanticSettings(db);
  if (context) {
    try {
      if (semanticSettings.mode !== 'keyword' && (!semanticSettings.enabled || !semanticSettings.baseUrl || !semanticSettings.model))
        throw new Error("请配置 Embedding 地址和模型");
      await progress(
        "retrieving",
        "正在准备产品范围内的检索索引",
      );
      semantic = await prepareSemanticCatalog(db, context, signal);
    } catch (error) {
      signal.throwIfAborted();
      await audit(db, projectId, null, runId, "semantic_fallback", {
        reason: error instanceof Error ? error.message : "Embedding 不可用",
      });
      await progress("retrieving", "语义检索暂不可用，回退完整目录方案");
    }
  }
  const selectedBatches = new Map<number, Promise<QuickPacket[]>>();
  const directRequirements = new Set<string>();
  const semanticRequirements = new Set<string>();
  const prepared =
    pending.length && !context
      ? await prepareSelectedSearch(db, projectId, runId, signal)
      : undefined;
  await runEvidencePipeline(
    pending,
    signal,
    async (row, pipelineSignal) => {
      activeRetrievals.set(row.data.id, Date.now());
      await progress(
        "retrieving",
        context
          ? `正在从完整目录选择 ${row.data.id} 的候选销售项`
          : `正在检索 ${row.data.id} 的候选销售项`,
      );
      try {
        if (context && select) {
          const batchIndex = Math.floor(pending.indexOf(row) / batchSize);
          let selection = selectedBatches.get(batchIndex);
          if (!selection) {
            const requirements = pending
              .slice(batchIndex * batchSize, batchIndex * batchSize + batchSize)
              .map((r) => r.data);
            const direct = requirements.map((requirement) => ({
              requirement,
              candidates: context.candidates,
              searches: [],
            }));
            if (semantic) {
              selection = semantic(requirements)
                .then((packets) => {
                  packets.forEach((p) =>
                    semanticRequirements.add(p.requirement.id),
                  );
                  packets.filter(p => p.candidates.length === context.candidates.length)
                    .forEach(p => directRequirements.add(p.requirement.id));
                  return packets;
                })
                .catch(async (error) => {
                  pipelineSignal.throwIfAborted();
                  await audit(db, projectId, null, runId, "semantic_fallback", {
                    requirementIds: requirements.map((r) => r.id),
                    reason:
                      error instanceof Error
                        ? error.message
                        : "Embedding 不可用",
                  });
                  return selectCatalogPackets(
                    context,
                    requirements,
                    select,
                    pipelineSignal,
                    budget,
                  );
                });
            } else if (
              JSON.stringify(judgmentPayload(direct)).length <= budget
            ) {
              requirements.forEach((r) => directRequirements.add(r.id));
              selection = Promise.resolve(direct);
            } else
              selection = selectCatalogPackets(
                context,
                pending
                  .slice(
                    batchIndex * batchSize,
                    batchIndex * batchSize + batchSize,
                  )
                  .map((r) => r.data),
                select,
                pipelineSignal,
                budget,
              );
            selectedBatches.set(batchIndex, selection);
          }
          const packet = (await selection).find(
            (p) => p.requirement.id === row.data.id,
          )!;
          await audit(db, projectId, null, runId, "product_scoped_search", {
            requirementId: row.data.id,
            query: row.data.raw,
            scopeRevision: context.scopeRevision,
            matchCount: packet.candidates.length,
            mode: semanticRequirements.has(row.data.id)
              ? semanticSettings.mode
              : directRequirements.has(row.data.id)
                ? "catalog_direct"
                : "catalog_model",
            catalogSize: context.index.length,
          });
          counters.retrieved++;
          await progress(
            "retrieving",
            `已按完整产品目录准备 ${counters.retrieved} 条需求的候选全文`,
          );
          return packet;
        }
        const packet: QuickPacket = {
          requirement: row.data,
          candidates: [],
          searches: [],
        };
        for (const child of row.data.subrequirements!) {
          const response = await searchSelected(
            db,
            projectId,
            runId,
            row.data.id,
            child.raw.slice(0, 1000),
            3,
            pipelineSignal,
            child.id,
            cache,
            prepared,
          );
          packet.searches.push({
            subrequirementId: child.id,
            query: child.raw.slice(0, 1000),
            traceId: response.traceId,
          });
          for (const hit of response.results) {
            for (const owner of hit.products) {
              if (
                !packet.candidates.some(
                  (c) => c.path === hit.path && c.product === owner.name,
                )
              )
                packet.candidates.push({
                  path: hit.path,
                  snapshotId: hit.snapshotId,
                  sales: hit.sales,
                  moduleId: hit.moduleId ?? "",
                  product: owner.name,
                  version: owner.version,
                  excerpts: hit.excerpts,
                  saleItemId: "saleItemId" in hit ? hit.saleItemId : undefined,
                  knowledgeReleaseId:
                    "knowledgeReleaseId" in hit
                      ? hit.knowledgeReleaseId
                      : undefined,
                });
            }
          }
        }
        counters.retrieved++;
        await progress(
          "retrieving",
          `已准备 ${counters.retrieved} 条需求的候选证据`,
        );
        return packet;
      } catch (error) {
        pipelineSignal.throwIfAborted();
        counters.failed++;
        terminalErrors.push(error);
        await failure([row.data.id], "检索", error);
        return null;
      } finally {
        activeRetrievals.delete(row.data.id);
      }
    },
    async (packets, pipelineSignal) => {
      for (const batch of planQuickBatches(packets, budget, batchSize)) {
        pipelineSignal.throwIfAborted();
        let done = false;
        let feedback = "";
        let currentStage = "模型判断";
        for (let attempt = 0; attempt < 2 && !done; attempt++) {
          try {
            currentStage = "模型判断";
            batchStage = "judging";
            batchMessage = `正在判断 ${batch.map((p) => p.requirement.id).join("、")}${attempt ? "（重试）" : ""}`;
            await progress(
              "judging",
              `正在判断 ${batch.map((p) => p.requirement.id).join("、")}${attempt ? "（重试）" : ""}`,
            );
            let result = parseQuickJudgments(
              await invokeJudge(batch, feedback, pipelineSignal),
              batch.map((p) => p.requirement.id),
            );
            for (const value of result) judged.add(value.requirementId);
            counters.judged = judged.size;
            await progress("judging", batchMessage);
            if (attempt === 0 && context && select) {
              const unresolved = result.filter(
                (value) =>
                  !directRequirements.has(value.requirementId) &&
                  value.checks.some(
                    (c) =>
                      c.level === "unknown" ||
                      c.level === "no_match" ||
                      (semanticRequirements.has(value.requirementId) &&
                        c.level === "partial"),
                  ),
              );
              if (unresolved.length) {
                currentStage = "产品内全量复查";
                await progress(
                  "judging",
                  "正在从完整产品目录复查证据不足的条款",
                );
                const extra = await selectCatalogPackets(
                  context,
                  unresolved.map(
                    (value) =>
                      batch.find(
                        (p) => p.requirement.id === value.requirementId,
                      )!.requirement,
                  ),
                  select,
                  pipelineSignal,
                  budget,
                  `首次判断存在缺口，请再次检查全部目录，寻找遗漏或组合销售项。${JSON.stringify(unresolved.map((v) => ({ requirementId: v.requirementId, checks: v.checks.map((c) => ({ reason: c.reason, level: c.level })) })))}`,
                );
                const changed = new Set<string>();
                for (const packet of extra) {
                  const target = batch.find(
                    (p) => p.requirement.id === packet.requirement.id,
                  )!;
                  for (const c of packet.candidates)
                    if (
                      !target.candidates.some(
                        (other) =>
                          other.path === c.path && other.product === c.product,
                      )
                    ) {
                      target.candidates.push(c);
                      changed.add(packet.requirement.id);
                    }
                }
                const retained = result.filter(
                  (v) => !changed.has(v.requirementId),
                );
                await audit(db, projectId, null, runId, "catalog_recheck", {
                  requirementIds: unresolved.map((v) => v.requirementId),
                  changed: [...changed],
                  skippedJudgments: unresolved
                    .filter((v) => !changed.has(v.requirementId))
                    .map((v) => v.requirementId),
                });
                result = retained;
                for (const part of planQuickBatches(
                  batch.filter((p) => changed.has(p.requirement.id)),
                  budget,
                ))
                  result.push(
                    ...parseQuickJudgments(
                      await invokeJudge(
                        part,
                        "已复查完整产品目录，请依据候选全文判断，证据不足仍保留unknown。",
                        pipelineSignal,
                      ),
                      part.map((p) => p.requirement.id),
                    ),
                  );
              }
            }
            if (attempt === 0 && !context) {
              currentStage = "证据补查";
              let supplemented = false;
              for (const value of result) {
                const packet = batch.find(
                  (p) => p.requirement.id === value.requirementId,
                )!;
                for (const check of value.checks.filter(
                  (c) =>
                    c.level === "unknown" ||
                    c.level === "no_match" ||
                    (semanticRequirements.has(value.requirementId) &&
                      c.level === "partial"),
                )) {
                  const child = packet.requirement.subrequirements?.find(
                    (c) => c.id === check.subrequirementId,
                  ) ?? {
                    id: check.subrequirementId,
                    raw: packet.requirement.raw,
                  };
                  batchStage = "retrieving";
                  batchMessage = `正在补查 ${value.requirementId} / ${child.id}`;
                  await progress("retrieving", batchMessage);
                  const query = `${child.raw.slice(0, 900)} 技术规格`;
                  const response = await searchSelected(
                    db,
                    projectId,
                    runId,
                    value.requirementId,
                    query,
                    5,
                    pipelineSignal,
                    child.id,
                    cache,
                    prepared,
                  );
                  packet.searches.push({
                    subrequirementId: child.id,
                    query,
                    traceId: response.traceId,
                  });
                  for (const hit of response.results)
                    for (const owner of hit.products) {
                      if (
                        !packet.candidates.some(
                          (c) =>
                            c.path === hit.path && c.product === owner.name,
                        )
                      )
                        packet.candidates.push({
                          path: hit.path,
                          snapshotId: hit.snapshotId,
                          sales: hit.sales,
                          moduleId: hit.moduleId ?? "",
                          product: owner.name,
                          version: owner.version,
                          excerpts: hit.excerpts,
                          saleItemId:
                            "saleItemId" in hit ? hit.saleItemId : undefined,
                          knowledgeReleaseId:
                            "knowledgeReleaseId" in hit
                              ? hit.knowledgeReleaseId
                              : undefined,
                        });
                    }
                  supplemented = true;
                }
                if (
                  value.checks.some(
                    (c) =>
                      c.level === "unknown" ||
                      c.level === "no_match" ||
                      (semanticRequirements.has(value.requirementId) &&
                        c.level === "partial"),
                  )
                ) {
                  batchStage = "retrieving";
                  batchMessage = `${value.requirementId} 范围内证据不足，正在补查`;
                  await progress(
                    "retrieving",
                    `${value.requirementId} 范围内证据不足，进行一次全局补查`,
                  );
                  const alternative = await searchGlobalFallback(
                    db,
                    projectId,
                    runId,
                    {
                      requirementId: value.requirementId,
                      query: packet.requirement.raw.slice(0, 900),
                      topK: 3,
                      reason: "insufficient_evidence",
                      explanation:
                        "快速初评在已选产品范围内证据不足，补查其他产品，仅供后续选型参考，不纳入本次正式匹配",
                    },
                    pipelineSignal,
                  );
                  packet.alternativeNote = `全局补查完成，范围外候选仅供另行选型，不能作为当前条款的满足证据。${JSON.stringify(alternative).slice(0, 2500)}`;
                }
              }
              if (supplemented) {
                if (JSON.stringify(judgmentPayload(batch)).length > budget)
                  throw new Error("补查证据超过批次预算，请使用深度评估");
                currentStage = "补查后判断";
                batchStage = "judging";
                batchMessage = `正在重新判断 ${batch.map((p) => p.requirement.id).join("、")}`;
                await progress("judging", batchMessage);
                result = parseQuickJudgments(
                  await invokeJudge(batch, undefined, pipelineSignal),
                  batch.map((p) => p.requirement.id),
                );
              }
            }
            pipelineSignal.throwIfAborted();
            const live = await productScope(db, projectId);
            if (live.revision !== scope.revision)
              throw new Error("产品范围已变化，请重新开始初评");
            const items = result.map((v) => ({
              ...buildQuickAssessment(
                batch.find((p) => p.requirement.id === v.requirementId)!,
                v,
                scope.selected[0],
              ),
              productScopeRevision: scope.revision,
            }));
            currentStage = "保存校验";
            batchStage = "saving";
            batchMessage = `正在校验并保存 ${batch.map((p) => p.requirement.id).join("、")}`;
            await progress("saving", batchMessage);
            let savedInBatch = 0;
            for (const item of items) {
              try {
                await saveAssessments(db, projectId, [item], { runId });
                counters.saved++;
                savedInBatch++;
              } catch (error) {
                pipelineSignal.throwIfAborted();
                const detail = await failure(
                  [item.requirementId],
                  "保存校验",
                  error,
                  1,
                  true,
                );
                try {
                  const packet = batch.find(
                    (p) => p.requirement.id === item.requirementId,
                  )!;
                  const [repaired] = parseQuickJudgments(
                    await invokeJudge([packet], detail, pipelineSignal),
                    [item.requirementId],
                  );
                  const corrected = {
                    ...buildQuickAssessment(
                      packet,
                      repaired,
                      scope.selected[0],
                    ),
                    productScopeRevision: scope.revision,
                  };
                  await saveAssessments(db, projectId, [corrected], { runId });
                  counters.saved++;
                  savedInBatch++;
                } catch (repairError) {
                  pipelineSignal.throwIfAborted();
                  await failure(
                    [item.requirementId],
                    "保存校验",
                    repairError,
                    2,
                    false,
                  );
                  counters.failed++;
                  terminalErrors.push(repairError);
                }
              }
            }
            done = true;
            batchStage = "";
            batchMessage = "";
            await progress(
              "saving",
              `本批 ${savedInBatch}/${batch.length} 条已保存`,
            );
          } catch (error) {
            pipelineSignal.throwIfAborted();
            feedback = await failure(
              batch.map((p) => p.requirement.id),
              currentStage,
              error,
              attempt + 1,
              attempt === 0,
            );
            if (attempt === 1) {
              counters.failed += batch.length;
              terminalErrors.push(error);
            }
          }
        }
        batchStage = "";
        batchMessage = "";
      }
    },
    { batchSize, concurrency: config.QUICK_CONCURRENCY },
  );
  await progress(
    counters.failed ? "failed" : "completed",
    counters.failed
      ? "部分条款失败，已保存结果保留，重新开始可继续"
      : "初评已保存，请核对后导出初评报告",
  );
  if (counters.failed)
    throw new AppError(
      terminalErrors.length > 0 && terminalErrors.every(isTransientFailure)
        ? 503
        : 422,
      `${counters.failed} 条初评未完成，已有结果已保存，可重新开始继续`,
    );
  return true;
}
