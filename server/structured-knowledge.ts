import { overviewInput } from "./product-overviews.js";
import { createHash } from "node:crypto";
import { stringify } from "yaml";
import type { Database } from "./db.js";
import { AppError } from "./errors.js";
import { snapshotPage } from "./wiki.js";
import {
  liveKnowledge, getProjectKnowledge,
} from "./product-knowledge.js";
import type {
  KnowledgeRelease,
  KnowledgeSale,
} from "../shared/product-knowledge.js";

export async function projectKnowledge(
  db: Database,
  projectId: string,
  bind = false,
) {
  const live = await liveKnowledge(db);
  const [project] = await db.query<{wiki_project_id:string}>("SELECT wiki_project_id FROM projects WHERE id=$1",[projectId]);
  if (!project) throw new AppError(404,"项目不存在");
  if (project.wiki_project_id === 'pg' || live.data.products.length) return live;
  // Read-only bridge for installations with historical Wiki/release data and no PG import yet.
  return getProjectKnowledge(db, projectId);
}

export function knowledgePath(
  releaseId: string,
  kind: "products" | "sale-items",
  id: string,
) {
  const key = createHash("sha256").update(id).digest("hex");
  return `wiki/structured/${releaseId}/${kind}/${key}.md`;
}

export function knowledgeChoice(
  release: KnowledgeRelease,
  choice: { name: string; version: string; path?: string },
) {
  const matches = release.data.products.filter((p) =>
    [
      p.product_id,
      p.product_code,
      p.name,
      p.source_path,
      knowledgePath(release.id, "products", p.product_id),
    ].some((v) => v === choice.name || (!!choice.path && v === choice.path)),
  );
  if (matches.length !== 1)
    throw new AppError(422, "PG 产品未唯一定位，请核对产品标识");
  const product = matches[0];
  const version = release.data.versions.find(
    (v) =>
      v.product_id === product.product_id &&
      v.version.replace(/^v/i, "") === choice.version.replace(/^v/i, ""),
  );
  if (!version)
    throw new AppError(422, "PG 中不存在已启用的所选产品版本");
  return { product, version };
}

export function saleMarkdown(release: KnowledgeRelease, sale: KnowledgeSale) {
  const version = release.data.versions.find(
    (v) => v.product_version_id === sale.product_version_id,
  )!;
  const product = release.data.products.find(
    (p) => p.product_id === version.product_id,
  )!;
  const category =
    release.data.categories.find((c) => c.category_id === sale.category_id)
      ?.name ?? "未分类";
  const dependencies = release.data.dependencies
    .filter(
      (d) =>
        d.sale_item_id === sale.sale_item_id &&
        d.dependency_type === "required",
    )
    .map((d) =>
      knowledgePath(release.id, "sale-items", d.depends_on_sale_item_id),
    );
  return `---\n${stringify({
    type: "sale-item",
    title: sale.name,
    product: product.product_code,
    version: version.version,
    sale_item_id: sale.sale_item_id,
    knowledge_release_id: release.id,
    product_id: product.product_id,
    module_id: sale.module_code,
    category,
    unit: sale.unit,
    fixed_price: sale.fixed_price,
    mandatory: sale.mandatory,
    dependencies,
    pricing_note: [
      sale.pricing_note,
      `计价方式：${sale.price_type}；币种：${sale.currency ?? "未核实"}`,
    ]
      .filter(Boolean)
      .join("；"),
    source_path: sale.source_path,
  })}---\n# ${sale.name}\n\n> PG 销售项记录；来源路径：${sale.source_path ?? "未提供"}。引用时保存证据副本，后续维护不改写已有引用。\n\n## 销售项描述\n${sale.description ?? ""}\n\n## 技术规格\n${sale.specification_md?.trim() || "技术规格待确认：本项仅供候选或定制参考，不能作为完全满足的能力证据。"}\n\n## 授权说明\n${sale.authorization_note ?? "未核实"}\n\n## 使用前提\n${sale.prerequisites ?? "未核实"}\n\n## 限制条件\n${sale.limitations ?? "未核实"}\n\n## 依赖说明\n${sale.dependency_note ?? ""}\n${release.data.dependencies
    .filter((d) => d.sale_item_id === sale.sale_item_id)
    .map(
      (d) =>
        `- ${d.dependency_type}：${d.depends_on_sale_item_id}；${d.condition_note ?? ""}；依据：${d.source_note}`,
    )
    .join("\n")}\n`;
}

export function productMarkdown(release: KnowledgeRelease, productId: string) {
  const p = release.data.products.find((p) => p.product_id === productId)!;
  return `---\n${stringify({ type: "product", title: p.product_code, product_id: p.product_id, knowledge_release_id: release.id })}---\n# ${p.product_code}\n\n${p.summary ?? ""}\n\n${release.data.versions
    .filter((v) => v.product_id === p.product_id)
    .map(
      (v) =>
        `### ${v.version}\n${versionOverview(release,v.product_version_id)}\n${release.data.saleItems
          .filter((s) => s.product_version_id === v.product_version_id)
          .map(
            (s) =>
              `- [${s.name}](${knowledgePath(release.id, "sale-items", s.sale_item_id)})`,
          )
          .join("\n")}`,
    )
    .join("\n")}\n`;
}

export function overviewMarkdown(release: KnowledgeRelease) {
  return `# 产品总览\n\n> PG 实时产品档案；产品版本概览来源于该版本销售项。\n\n${release.data.products
    .map(
      (p) =>
        `## ${p.product_code}\n产品标识：${p.product_code}\n产品名称：${p.name}\n产品线：${p.product_line ?? "未提供"}\n所属部门：${p.department ?? "未提供"}\n维护人：${p.owner ?? "未提供"}\n产品档案：${knowledgePath(release.id, "products", p.product_id)}\n版本：${release.data.versions
          .filter((v) => v.product_id === p.product_id)
          .map((v) => v.version)
          .join(
            "、",
          )}\n\n${p.summary ?? ""}\n适用场景：${p.scenarios ?? "未提供"}\n能力边界：${p.boundaries ?? "未提供"}\n${release.data.versions.filter(v => v.product_id === p.product_id).map(v => `### ${v.version}\n${versionOverview(release,v.product_version_id)}`).join("\n")}\n`,
    )
    .join("\n")}`;
}

export function versionOverview(source: KnowledgeRelease, versionId: string) {
  const saved = source.overviews?.find(o => o.product_version_id === versionId);
  if (saved && saved.input_hash === overviewInput(source,versionId).hash) {
    const o = saved.overview;
    return `产品定位：${o.positioning}\n适用场景：${o.scenarios.join("、")}\n业务模块：\n${o.modules.map(m => `- ${m.name}：${m.capabilities.join("；")}；支撑销售项ID：${m.saleItemIds.join("、")}`).join("\n")}\n明确限制：${o.limitations.join("；") || "未明确"}\n待核实：${o.unspecified.join("；") || "未明确"}`;
  }
  return `概览${saved ? "待更新" : "尚未生成"}，以下仅为已维护销售项名称，不代表逐条满足：${source.data.saleItems.filter(s => s.product_version_id === versionId).map(s => s.name).join("、")}`;
}

export function knowledgeContent(release: KnowledgeRelease, path: string) {
  if (path === "wiki/overview.md") return overviewMarkdown(release);
  const product = release.data.products.find(
    (p) => knowledgePath(release.id, "products", p.product_id) === path || p.source_path === path,
  );
  if (product) return productMarkdown(release, product.product_id);
  const sales = release.data.saleItems.filter(
    (s) => knowledgePath(release.id, "sale-items", s.sale_item_id) === path || s.source_path === path,
  );
  const sale = sales.length === 1 ? sales[0] : undefined;
  return sale ? saleMarkdown(release, sale) : undefined;
}

export async function materializeProduct(
  db: Database,
  projectId: string,
  release: KnowledgeRelease,
  choice: { name: string; version: string; path?: string },
) {
  const { product } = knowledgeChoice(release, choice);
  return snapshotPage(
    db,
    projectId,
    knowledgePath(release.id, "products", product.product_id),
    productMarkdown(release, product.product_id),
  );
}
