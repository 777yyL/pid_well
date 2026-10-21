import { createHash } from "node:crypto";
import { stringify } from "yaml";
import type { Database } from "./db.js";
import { AppError } from "./errors.js";
import { snapshotPage } from "./wiki.js";
import {
  bindProjectKnowledge,
  getProjectKnowledge,
  latestKnowledge,
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
  const current = await getProjectKnowledge(db, projectId);
  if (current || !bind) return current;
  const [project] = await db.query<{ wiki_project_id: string }>(
    "SELECT wiki_project_id FROM projects WHERE id=$1",
    [projectId],
  );
  if (!project) throw new AppError(404, "项目不存在");
  // Never silently convert an existing Wiki-based assessment or recommendation.
  const [used] = await db.query(
    "SELECT 1 FROM snapshots WHERE project_id=$1 UNION ALL SELECT 1 FROM assessments WHERE project_id=$1 UNION ALL SELECT 1 FROM product_scopes WHERE project_id=$1 AND (status<>'pending' OR jsonb_array_length(recommendations)>0) LIMIT 1",
    [projectId],
  );
  if (used) return null;
  const release = await latestKnowledge(db, project.wiki_project_id);
  if (!release) return null;
  await bindProjectKnowledge(db, projectId, release.id);
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
    throw new AppError(422, "发布目录中产品未唯一定位，请核对产品标识与路径");
  const product = matches[0];
  const version = release.data.versions.find(
    (v) =>
      v.product_id === product.product_id &&
      v.version.replace(/^v/i, "") === choice.version.replace(/^v/i, ""),
  );
  if (!version)
    throw new AppError(422, "发布目录中不存在所选产品版本，请明确选择版本");
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
  })}---\n# ${sale.name}\n\n> 结构化发布快照：${release.name}；来源路径：${sale.source_path ?? "未提供"}。此页为发布数据的固定渲染，非远端文件原文。\n\n## 销售项描述\n${sale.description ?? ""}\n\n## 技术规格\n${sale.specification_md ?? ""}\n\n## 授权说明\n${sale.authorization_note ?? "未核实"}\n\n## 使用前提\n${sale.prerequisites ?? "未核实"}\n\n## 限制条件\n${sale.limitations ?? "未核实"}\n\n## 依赖说明\n${sale.dependency_note ?? ""}\n${release.data.dependencies
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
        `### ${v.version}\n${release.data.saleItems
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
  return `# 产品总览\n\n> 结构化发布版本：${release.name}（${release.id}）\n\n${release.data.products
    .map(
      (p) =>
        `## ${p.product_code}\n产品标识：${p.product_code}\n产品名称：${p.name}\n产品线：${p.product_line ?? "未提供"}\n所属部门：${p.department ?? "未提供"}\n维护人：${p.owner ?? "未提供"}\n产品档案：${knowledgePath(release.id, "products", p.product_id)}\n版本：${release.data.versions
          .filter((v) => v.product_id === p.product_id)
          .map((v) => v.version)
          .join(
            "、",
          )}\n\n${p.summary ?? ""}\n适用场景：${p.scenarios ?? "未提供"}\n能力边界：${p.boundaries ?? "未提供"}\n`,
    )
    .join("\n")}`;
}

export function knowledgeContent(release: KnowledgeRelease, path: string) {
  if (path === "wiki/overview.md") return overviewMarkdown(release);
  const product = release.data.products.find(
    (p) => knowledgePath(release.id, "products", p.product_id) === path,
  );
  if (product) return productMarkdown(release, product.product_id);
  const sale = release.data.saleItems.find(
    (s) => knowledgePath(release.id, "sale-items", s.sale_item_id) === path,
  );
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
