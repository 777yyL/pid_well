import { Type, type TSchema } from "typebox";
import { z } from "zod";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { randomUUID } from "node:crypto";
import type { Database } from "./db.js";
import { audit } from "./db.js";
import {
  requirementSchema,
  assessmentSchema,
  criteriaSchema,
  productCandidateSchema,
  productCombinationSchema,
} from "../shared/domain.js";
import {
  saveRequirements,
  saveAssessments,
  assessmentRows,
} from "./assessment.js";
import { WikiClient, snapshotPage, PRODUCT_OVERVIEW_PATH } from "./wiki.js";
import { numberedLines } from "./documents.js";
import { createReport } from "./reports.js";
import { AppError } from "./errors.js";
import {
  productScope,
  recommendProducts,
  recommendProductPlans,
} from "./product-scope.js";
import {
  readCatalogPage,
  searchSelected,
  searchGlobalFallback,
  alternativeSchema,
  recordAlternative,
} from "./product-search.js";
import { loadSettings } from "./settings.js";
export interface ToolContext {
  db: Database;
  projectId: string;
  conversationId: string;
  runId: string;
  userId: string;
  emit: (type: string, payload: Record<string, unknown>) => Promise<void>;
}
export function createTools(ctx: ToolContext): AgentTool[] {
  const { db, projectId, conversationId, runId } = ctx;
  const tool = <T extends z.ZodType>(
    name: string,
    label: string,
    description: string,
    schema: T,
    handler: (args: z.infer<T>, signal?: AbortSignal) => Promise<unknown>,
  ): AgentTool => ({
    name,
    label,
    description,
    parameters: z.toJSONSchema(schema) as TSchema,
    executionMode: "sequential",
    execute: async (_id, args, signal) => {
      signal?.throwIfAborted();
      const result = await handler(schema.parse(args), signal);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: {},
      };
    },
  });
  const readWiki = async (
    args: { path: string; start: number; count: number },
    signal?: AbortSignal,
  ) => {
    const [p] = await db.query<{ wiki_project_id: string }>(
      "SELECT wiki_project_id FROM projects WHERE id=$1",
      [projectId],
    );
    const content = await new WikiClient(db, signal).read(
      p.wiki_project_id,
      args.path,
    );
    const snapshot = await snapshotPage(db, projectId, args.path, content);
    const lines = content.split(/\r?\n/);
    return {
      snapshotId: snapshot.id,
      path: args.path,
      hash: snapshot.hash,
      total: lines.length,
      text: numberedLines(lines, args.start, args.count),
    };
  };
  return [
    tool(
      "project_context",
      "查看项目",
      "读取项目背景、文件列表、已抽取要求、评估结果和人工修改。开始每次任务时先读取。",
      z.object({
        offset: z.number().int().min(0).default(0),
        count: z.number().int().min(1).max(50).default(20),
      }),
      async (args) => {
        const [project] = await db.query(
          "SELECT id,name,description,wiki_project_id FROM projects WHERE id=$1",
          [projectId],
        );
        const documents = await db.query(
          "SELECT id,name,status,error,jsonb_array_length(lines) AS line_count FROM documents WHERE project_id=$1 ORDER BY created_at",
          [projectId],
        );
        const requirements = await db.query(
          "SELECT id,data,confirmed FROM requirements WHERE project_id=$1 ORDER BY id LIMIT $2 OFFSET $3",
          [projectId, args.count, args.offset],
        );
        const findings = await db.query(
          "SELECT data FROM audit_log WHERE project_id=$1 AND action='finding' ORDER BY id DESC LIMIT 10",
          [projectId],
        );
        const [counts] = await db.query(
          "SELECT count(*)::int AS total, count(*) FILTER (WHERE confirmed=true)::int AS confirmed FROM requirements WHERE project_id=$1",
          [projectId],
        );
        const [conversation] = await db.query(
          "SELECT plan,checkpoint FROM conversations WHERE id=$1 AND project_id=$2",
          [conversationId, projectId],
        );
        return {
          project,
          productOverview: {
            path: PRODUCT_OVERVIEW_PATH,
            tool: "wiki_overview",
            instruction:
              "产品总览路径固定，直接调用 wiki_overview，无需搜索或猜测路径",
          },
          productScope: await productScope(db, projectId),
          searchWorkflow:
            "先 wiki_product_catalog 完整读取已选产品销售项目录，再 wiki_search(requirementId) 产品内检索；未命中或证据不足才能 wiki_global_search。范围外结果 record_product_alternative，等待用户加入范围。",
          alternatives: await db.query(
            "SELECT id,data FROM audit_log WHERE project_id=$1 AND action='product_alternative' ORDER BY id DESC LIMIT 100",
            [projectId],
          ),
          documents,
          requirements,
          assessments: await assessmentRows(
            db,
            projectId,
            args.count,
            args.offset,
          ),
          findings,
          counts,
          plan: conversation?.plan,
          checkpoint: conversation?.checkpoint,
          offset: args.offset,
          nextOffset: args.offset + args.count,
        };
      },
    ),
    tool(
      "recommend_products",
      "推荐候选产品",
      "在读取当前清单和知识库总览后保存候选产品。列出覆盖方向、推荐理由、缺口和总览证据。提取总览中的 productId 产品标识、productLine 产品线/产品类目、department 产品部门/所属部门、owner 负责人/维护人、productName 展示名称；每个有值的字段必须逐字出现在 evidence.quote 中，缺失则留空，name 保留用于匹配的产品标识，productName 填产品名称；允许多个产品满足同一需求。推荐不等于用户选择，保存后等待用户在产品选型页确认，不得自动确定产品。",
      z.object({
        candidates: productCandidateSchema.array().min(1).max(20),
        combinations: productCombinationSchema.array().min(1).max(5),
      }),
      async (args) => {
        const result = await recommendProducts(
          db,
          projectId,
          args.candidates,
          runId,
          args.combinations,
        );
        await ctx.emit("products_recommended", {
          count: result.recommendations.length,
        });
        return result;
      },
    ),
    tool(
      "recommend_product_plans",
      "生成推荐选型方案",
      "针对已有候选推荐1–3套选型方案，解释建议选择哪些产品、各产品负责什么。只能引用现有候选名称及版本。保留候选基本信息、用户勾选及已确认产品范围；可用于补充旧推荐，不要再次 recommend_products 覆盖候选。先 project_context 获取 revision。",
      z.object({
        expectedRevision: z.number().int().positive(),
        combinations: productCombinationSchema.array().min(1).max(5),
      }),
      async (args) => {
        const result = await recommendProductPlans(
          db,
          projectId,
          args.combinations,
          runId,
          args.expectedRevision,
        );
        await ctx.emit("products_recommended", {
          count: result.recommendations.length,
        });
        return result;
      },
    ),
    tool(
      "update_plan",
      "更新执行计划",
      "维护用户可见的任务计划和步骤状态。计划应具体且随执行结果调整。",
      z.object({
        steps: z
          .array(
            z.object({
              id: z.string(),
              title: z.string().min(1).max(200),
              status: z.enum(["pending", "running", "done", "blocked"]),
            }),
          )
          .min(1)
          .max(20),
      }),
      async (args) => {
        await db.query(
          "UPDATE conversations SET plan=$1,updated_at=now() WHERE id=$2",
          [JSON.stringify(args.steps), conversationId],
        );
        await ctx.emit("plan_updated", { steps: args.steps });
        return { saved: true };
      },
    ),
    tool(
      "read_document",
      "读取招标原文",
      "按稳定行号读取本项目已上传文件，返回原文和行号。分批读取，不能遗漏文档后半部分。",
      z.object({
        documentId: z.string().uuid(),
        start: z.number().int().positive().default(1),
        count: z.number().int().min(1).max(250).default(150),
      }),
      async (args) => {
        const [doc] = await db.query<{ lines: string[]; name: string }>(
          "SELECT lines,name FROM documents WHERE id=$1 AND project_id=$2 AND status=$3",
          [args.documentId, projectId, "ready"],
        );
        if (!doc) throw new AppError(404, "本项目没有该已解析文件");
        return {
          name: doc.name,
          total: doc.lines.length,
          text: numberedLines(doc.lines, args.start, args.count),
        };
      },
    ),
    tool(
      "save_requirements",
      "保存抽取条款",
      "每次最多保存 10 条技术条款。优先只提供原文行号，不提供 raw，由服务端逐字提取对应行原文，避免复制长文本导致输出截断。不覆盖已确认条款，一个功能点一个 T 编号。",
      z.object({
        requirements: requirementSchema
          .extend({ raw: requirementSchema.shape.raw.optional() })
          .array()
          .min(1)
          .max(10),
      }),
      async (args) => {
        const items = [];
        for (const item of args.requirements) {
          const [doc] = await db.query<{ lines: string[] }>(
            "SELECT lines FROM documents WHERE id=$1 AND project_id=$2 AND status='ready'",
            [item.documentId, projectId],
          );
          if (!doc) throw new AppError(422, "要求必须来自本项目已解析的文档");
          items.push({
            ...item,
            raw:
              item.raw ??
              doc.lines.slice(item.lineStart - 1, item.lineEnd).join("\n"),
          });
        }
        const result = await saveRequirements(db, projectId, items, runId);
        const settings = await loadSettings(db);
        if (!settings.requireRequirementConfirmation) {
          await db.query(
            "UPDATE requirements SET confirmed=true WHERE project_id=$1 AND id=ANY($2::text[])",
            [projectId, args.requirements.map((i) => i.id)],
          );
          return { ...result, requiresConfirmation: false };
        }
        return result;
      },
    ),
    tool(
      "wiki_product_catalog",
      "读取已选产品销售项目录",
      "仅从已选产品页的所选版本销售项列表建立目录并读取实体，分页直至 complete=true。产品页位于 wiki/entities/products/，销售项实体位于 wiki/entities/sale-items/；不读取版本页、分类页。产品页缺少所选版本列表时要求补充产品页，禁止用全局搜索替代产品内检索。",
      z.object({
        offset: z.number().int().min(0).default(0),
        count: z.number().int().min(1).max(50).default(25),
      }),
      (args, signal) =>
        readCatalogPage(db, projectId, runId, args.offset, args.count, signal),
    ),
    tool(
      "wiki_search",
      "产品内检索销售项",
      "确认产品后仅检索已选产品目录内的正式销售项，必须提供已确认 requirementId。先完整读取 wiki_product_catalog。可更换关键词多次查询；不会自动全局搜索。未选产品阶段仅用于核实产品身份。",
      z.object({
        requirementId: z
          .string()
          .regex(/^T-\d+$/)
          .optional(),
        query: z.string().min(1).max(500),
        topK: z.number().int().min(1).max(10).default(5),
      }),
      async (args, signal) => {
        const scope = await productScope(db, projectId);
        if (scope.status === "confirmed") {
          if (!args.requirementId)
            throw new AppError(
              422,
              "产品内检索必须提供已确认条款 requirementId",
            );
          return searchSelected(
            db,
            projectId,
            runId,
            args.requirementId,
            args.query,
            args.topK,
            signal,
          );
        }
        const [p] = await db.query<{ wiki_project_id: string }>(
          "SELECT wiki_project_id FROM projects WHERE id=$1",
          [projectId],
        );
        const result = await new WikiClient(db, signal).search(
          p.wiki_project_id,
          args.query,
          args.topK,
        );
        const text = JSON.stringify(result);
        return text.length > 50000
          ? {
              truncated: true,
              result: text.slice(0, 50000),
              note: "结果过长，请缩小查询并读取实体页",
            }
          : result;
      },
    ),
    tool(
      "wiki_global_search",
      "证据不足时全局补查",
      "仅在同一条款、本次产品范围已完成产品内检索后调用。记录 no_match 或 insufficient_evidence 的具体原因。范围外能力只能单列替代建议，不能直接纳入正式结果。",
      z.object({
        requirementId: z.string().regex(/^T-\d+$/),
        query: z.string().min(1).max(500),
        topK: z.number().int().min(1).max(10).default(5),
        reason: z.enum(["no_match", "insufficient_evidence"]),
        explanation: z.string().min(10).max(2000),
      }),
      (args, signal) =>
        searchGlobalFallback(db, projectId, runId, args, signal),
    ),
    tool(
      "record_product_alternative",
      "记录范围外产品建议",
      "全局补查后核实其它产品与版本的目录及销售项实体，记录可满足条款的替代建议和准确原文证据。用户点击加入匹配范围后才能正式匹配，Agent 无权自行加入。",
      alternativeSchema,
      (args) => recordAlternative(db, projectId, runId, args),
    ),
    tool(
      "wiki_overview",
      "读取产品总览",
      "读取固定的 wiki/overview.md 产品总览并保存证据快照。产品推荐前直接调用，禁止搜索或猜测其它总览路径。支持按稳定行号分页。",
      z.object({
        start: z.number().int().positive().default(1),
        count: z.number().int().min(1).max(250).default(160),
      }),
      async (args, signal) =>
        readWiki({ ...args, path: PRODUCT_OVERVIEW_PATH }, signal),
    ),
    tool(
      "wiki_read",
      "读取知识库证据",
      "读取 wiki 页面并保存不可变证据快照。产品总览固定 wiki/overview.md，优先调用 wiki_overview 读取；本工具用于产品页与销售项详情。返回 snapshotId、稳定行号和原文，可分页。",
      z.object({
        path: z.string().min(1),
        start: z.number().int().positive().default(1),
        count: z.number().int().min(1).max(250).default(160),
      }),
      readWiki,
    ),
    tool(
      "wiki_graph",
      "查询产品关联",
      "查看产品、销售项和依赖的双链图谱，辅助补充依赖与组合产品。",
      z.object({ query: z.string().max(500) }),
      async (args, signal) => {
        const [p] = await db.query<{ wiki_project_id: string }>(
          "SELECT wiki_project_id FROM projects WHERE id=$1",
          [projectId],
        );
        return new WikiClient(db, signal).graph(p.wiki_project_id, args.query);
      },
    ),
    tool(
      "get_assessments",
      "读取指定评估与版本",
      "按条款编号直接查询结论、当前 revision、来源及复核状态；或仅列出未复核结果。版本冲突必须查询，禁止猜 revision 或重存来刷新版本。",
      z.object({
        ids: z
          .array(z.string().regex(/^T-\d+$/))
          .min(1)
          .max(50)
          .optional(),
        unreviewed: z.boolean().default(false),
        offset: z.number().int().min(0).default(0),
        count: z.number().int().min(1).max(50).default(20),
      }),
      async (args) => ({
        assessments: await assessmentRows(
          db,
          projectId,
          args.count,
          args.offset,
          args,
        ),
        offset: args.offset,
        nextOffset: args.offset + args.count,
      }),
    ),
    tool(
      "save_assessments",
      "保存匹配结果",
      "保存结构化匹配，五项依据必须完整。销售项必须正式名称，每个销售项附带实体页快照证据。已人工确认的结果禁止覆盖。保存后尚未复核。",
      z.object({ assessments: assessmentSchema.array().min(1).max(30) }),
      async (args) =>
        saveAssessments(db, projectId, args.assessments, { runId }),
    ),
    tool(
      "review_assessments",
      "记录逐条复核",
      "逐条核验五项依据、子系统覆盖、必选项和依赖，只有完全核验后记录复核。若发现错误先 save_assessments 修正，再读取最新版 revision 复核。",
      z.object({
        reviews: z
          .array(
            z.object({
              requirementId: z.string(),
              revision: z.number().int().positive(),
              checks: criteriaSchema,
              coverageConfirmed: z.literal(true),
              reason: z.string().min(10),
            }),
          )
          .min(1)
          .max(100),
      }),
      async (args) => {
        await db.transaction(async (tx) => {
          for (const review of args.reviews) {
            const [row] = await tx.query(
              "UPDATE assessments SET reviewed=true WHERE project_id=$1 AND requirement_id=$2 AND revision=$3 RETURNING id",
              [projectId, review.requirementId, review.revision],
            );
            if (!row) {
              const [current] = await tx.query<{
                revision: number;
                reviewed: boolean;
              }>(
                "SELECT revision,reviewed FROM assessments WHERE project_id=$1 AND requirement_id=$2",
                [projectId, review.requirementId],
              );
              throw new AppError(
                409,
                `${review.requirementId} 结论版本已变化，当前 revision=${current?.revision ?? "未保存"}；请 get_assessments 读取后按真实版本复核，禁止猜测或重复保存`,
              );
            }
            await audit(
              tx,
              projectId,
              null,
              runId,
              "assessment_reviewed",
              review,
            );
          }
        });
        return { reviewed: args.reviews.length };
      },
    ),
    tool(
      "record_finding",
      "记录项目分析",
      "保存项目背景、基本要求、资质和评分办法等阶段性分析。内容必须附原文证据；这不是技术条款存储工具。",
      z.object({
        category: z.enum([
          "项目背景",
          "基本要求",
          "资质要求",
          "评分办法",
          "风险说明",
        ]),
        content: z.string().min(1).max(30000),
      }),
      async (args) => {
        await audit(db, projectId, null, runId, "finding", args);
        await ctx.emit("finding", args);
        return { saved: true };
      },
    ),
    tool(
      "export_report",
      "生成正式报告",
      "基于全部已确认、匹配、复核的结果生成正式报告。不完整时拒绝生成；返回可下载链接。",
      z.object({
        format: z.enum(["xlsx", "csv", "html"]),
        kind: z.enum(["full", "sales"]).default("full"),
      }),
      async (args) => {
        const artifact = await createReport(
          db,
          projectId,
          args.format,
          args.kind,
        );
        await ctx.emit("artifact_created", artifact);
        return artifact;
      },
    ),
  ];
}
