import { z } from "zod";
import { createHash } from "node:crypto";
import type { Database } from "./db.js";
import { readCatalogPage } from "./product-search.js";
import { parseSaleEntity } from "./sale-entity.js";
import type { RequirementInput } from "../shared/domain.js";
import type { QuickPacket } from "./quick-assessment.js";

export type CatalogContext = Awaited<ReturnType<typeof loadCatalogContext>>;
export type CatalogSelector = (
  requirements: RequirementInput[],
  catalog: CatalogContext["index"],
  signal: AbortSignal,
  feedback?: string,
) => Promise<unknown>;

export async function loadCatalogContext(
  db: Database,
  projectId: string,
  runId: string,
  signal?: AbortSignal,
) {
  const catalog = await readCatalogPage(
    db,
    projectId,
    runId,
    0,
    100000,
    signal,
  );
  if (catalog.items.length !== catalog.total)
    throw new Error(
      "产品目录部分销售项无法核实所属产品版本，不能按完整目录继续匹配",
    );
  const pages = await db.query<{ id: string; content: string }>(
    "SELECT id,content FROM snapshots WHERE project_id=$1 AND id=ANY($2::uuid[])",
    [projectId, catalog.items.map((item) => item.snapshotId)],
  );
  const candidates: QuickPacket["candidates"] = [];
  const index: {
    id: string;
    sales: string;
    product: string;
    version: string;
    category: string;
    description: string;
    capabilities: string;
    moduleId: string;
  }[] = [];
  for (const item of catalog.items) {
    const page = pages.find((p) => p.id === item.snapshotId);
    if (!page) throw new Error("产品目录实体快照缺失");
    const entity = parseSaleEntity(page.content);
    for (const owner of item.products) {
      const id = `S-${createHash("sha256")
        .update(JSON.stringify([owner.name, owner.version, item.path]))
        .digest("hex")
        .slice(0, 24)}`;
      index.push({
        id,
        sales: entity.title,
        product: owner.name,
        version: owner.version,
        category: entity.category,
        moduleId: entity.moduleId,
        description: entity.description,
        capabilities: entity.specification,
      });
      candidates.push({
        path: item.path,
        snapshotId: page.id,
        sales: entity.title,
        product: owner.name,
        version: owner.version,
        moduleId: entity.moduleId,
        saleItemId: entity.saleItemId,
        knowledgeReleaseId: entity.knowledgeReleaseId,
        excerpts: [
          {
            lineStart: 1,
            lineEnd: page.content.split(/\r?\n/).length,
            quote: page.content,
          },
        ],
      });
    }
  }
  if (!index.length)
    throw new Error("所选产品版本没有可用销售项目录，不能据此判定需求不支持");
  return { scopeRevision: catalog.scopeRevision, index, candidates };
}

export function catalogPackets(
  context: CatalogContext,
  requirements: RequirementInput[],
  raw: unknown,
) {
  const value = z
    .object({
      selections: z.array(
        z.object({
          requirementId: z.string(),
          catalogIds: z.array(z.string()),
        }),
      ),
    })
    .parse(
      typeof raw === "string"
        ? JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, ""))
        : raw,
    );
  if (
    value.selections.length !== requirements.length ||
    new Set(value.selections.map((s) => s.requirementId)).size !==
      requirements.length ||
    value.selections.some(
      (s) => !requirements.some((r) => r.id === s.requirementId),
    )
  )
    throw new Error("候选选择必须完整覆盖本批条款，不能重复或遗漏");
  return requirements.map((requirement): QuickPacket => {
    const selected = value.selections.find(
      (s) => s.requirementId === requirement.id,
    )!;
    return {
      requirement,
      searches: [],
      candidates: [...new Set(selected.catalogIds)].map((id) => {
        const index = context.index.findIndex((entry) => entry.id === id);
        if (index < 0) throw new Error(`候选销售项不属于所选产品版本：${id}`);
        return context.candidates[index];
      }),
    };
  });
}

export async function selectCatalogPackets(
  context: CatalogContext,
  requirements: RequirementInput[],
  select: CatalogSelector,
  signal: AbortSignal,
  budget: number,
  feedback?: string,
) {
  const room = budget - JSON.stringify(requirements).length - 2000;
  const shards: CatalogContext["index"][] = [];
  for (const item of context.index) {
    if (JSON.stringify([item]).length > room)
      throw new Error("单个销售项超出目录上下文预算，请增加模型上下文配置");
    const last = shards.at(-1);
    if (!last || JSON.stringify([...last, item]).length > room)
      shards.push([item]);
    else last.push(item);
  }
  const packets = requirements.map((requirement): QuickPacket => ({
    requirement,
    candidates: [],
    searches: [],
  }));
  for (const shard of shards) {
    signal.throwIfAborted();
    const selected = catalogPackets(
      context,
      requirements,
      await select(requirements, shard, signal, feedback),
    );
    const allowed = new Set(
      shard.map((entry) => context.candidates[context.index.indexOf(entry)]),
    );
    for (const packet of selected) {
      if (packet.candidates.some((candidate) => !allowed.has(candidate)))
        throw new Error("候选不属于本次目录分片");
      const target = packets.find(
        (p) => p.requirement.id === packet.requirement.id,
      )!;
      target.candidates.push(
        ...packet.candidates.filter((c) => !target.candidates.includes(c)),
      );
    }
  }
  return packets;
}
