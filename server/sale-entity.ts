import { parse as parseYaml } from "yaml";
import { AppError } from "./errors.js";
import type { AssessmentInput } from "../shared/domain.js";

export interface SaleEntity {
  title: string;
  product: string;
  version: string;
  category: string;
  moduleId: string;
  unit: string;
  price?: number;
  quantity?: number;
  total?: number;
  mandatory: string;
  dependencies: string[];
  dependencyNote: string;
  quotation: string;
  description: string;
  specification: string;
}
const clean = (value: unknown) =>
  String(value ?? "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .trim();
const number = (value: unknown): number | undefined => {
  if (value === null || value === undefined || value === "") return;
  const text = clean(value)
    .replace(/[¥￥,，]/g, "")
    .replace(/元(?:\/.*)?$/, "")
    .trim();
  if (!/^\d+(?:\.\d+)?$/.test(text)) return;
  const result = Number(text);
  return Number.isFinite(result) ? result : undefined;
};
export function entitySection(text: string, name: string) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) =>
    new RegExp(`^(?:#{1,6}\\s*${name}\\s*|\\*\\*${name}\\*\\*\\s*)$`).test(
      line.trim(),
    ),
  );
  if (start < 0) return "";
  let end = start + 1;
  while (
    end < lines.length &&
    !/^(?:#{1,6}\s|\*\*[^*]+\*\*\s*$)/.test(lines[end].trim())
  )
    end++;
  return lines
    .slice(start + 1, end)
    .join("\n")
    .trim();
}
export function parseSaleEntity(content: string): SaleEntity {
  const front = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const meta = front ? (parseYaml(front[1]) ?? {}) : {};
  const body = front ? content.slice(front[0].length) : content;
  const fields = new Map<string, string>();
  const bodyLines = body.split(/\r?\n/);
  const separator = (line: string) => /^\s*\|?\s*:?-{3,}:?\s*\|/.test(line);
  for (const [index, line] of bodyLines.entries()) {
    if (/^\s*\|/.test(line)) {
      if (separator(line) || separator(bodyLines[index + 1] ?? "")) continue;
      const cells = line
        .replace(/\[\[([^\]|]+)\|[^\]]+\]\]/g, "[[$1]]")
        .split("|")
        .map(clean)
        .filter(Boolean);
      if (cells.length === 2 && !/^-+$/.test(cells[0]))
        fields.set(cells[0], cells[1]);
    }
    if (/^\s*[-*]\s/.test(line)) {
      for (const part of line.replace(/^\s*[-*]\s*/, "").split(/\s+[｜|]\s+/)) {
        const match = part.match(
          /^\s*(?:\*\*)?([^:：]+?)(?:\*\*)?[:：]\s*(.*)$/,
        );
        if (match) fields.set(clean(match[1]), clean(match[2]));
      }
    }
  }
  const get = (...names: string[]) => {
    for (const name of names)
      if (meta[name] !== undefined && meta[name] !== null) return meta[name];
    for (const name of names) if (fields.has(name)) return fields.get(name);
    return "";
  };
  const banner = body.match(
    /^>\s*产品\s+\[([^\]]+)\]\([^)]*\)\s*(\S+)\s*·\s*分类\s+([^·\n]+)/m,
  );
  const deps = get("dependencies", "depends_on", "依赖销售项", "依赖项");
  const dependencyNote = Array.isArray(deps)
    ? deps.map(clean).join("、")
    : clean(deps);
  const dependencies = (
    Array.isArray(deps) ? deps.map(clean) : [clean(deps)]
  ).flatMap((value) => {
    const primary = value.split(/[（(]/)[0].trim();
    if (/^(?:无|否|不依赖|无需)$/.test(primary)) return [];
    const links = [...primary.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)].map(
      (m) => m[1],
    );
    return links.length
      ? links
      : primary
          .split(/[、,，;；]/)
          .map(clean)
          .filter(Boolean);
  });
  return {
    title: clean(
      get("title", "销售项名称", "名称") || body.match(/^#\s+(.+)$/m)?.[1],
    ),
    product: clean(get("product", "产品", "所属产品") || banner?.[1]).replace(
      /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
      (_match, path, label) => label || path,
    ),
    version: clean(get("version", "版本", "产品版本") || banner?.[2]),
    category: clean(get("category", "分类", "产品类别") || banner?.[3]),
    moduleId: clean(get("module_id", "moduleId", "模块ID", "模块 ID", "型号")),
    unit: clean(get("unit", "单位")),
    price: number(get("fixed_price", "固定价", "单价")),
    quantity: number(get("quantity", "数量")),
    total: number(get("total_price", "合价")),
    mandatory:
      typeof get("mandatory", "required", "必选") === "boolean"
        ? get("mandatory", "required", "必选")
          ? "是"
          : "否"
        : clean(get("mandatory", "required", "必选")),
    dependencies,
    dependencyNote,
    quotation: clean(get("quotation", "pricing_note", "报价说明")),
    description:
      entitySection(body, "销售项描述") ||
      clean(get("description", "销售项描述")),
    specification:
      entitySection(body, "技术规格") ||
      clean(get("specification", "技术规格")),
  };
}

export const salesHeaders = [
  "序号",
  "名称",
  "产品类别",
  "型号",
  "技术规格",
  "单位",
  "数量",
  "单价",
  "合价",
  "备注",
];
export interface SalePage {
  id: string;
  path: string;
  content: string;
  hash: string;
}
export interface SaleMatch {
  existingAuthorization?: boolean;
  level?: AssessmentInput["level"];
  verification?: AssessmentInput["verification"];
  sales: string[];
  product: string;
  version: string;
  requirementId: string;
  evidence: { snapshotId: string }[];
}
export function collectSales(rows: SaleMatch[], pages: SalePage[]) {
  rows = rows.flatMap((row) => {
    if (row.level === "unknown" || row.level === "no_match") return [];
    if (!row.verification) return [row];
    return row.verification.contributions
      .filter((c) => ["purchase", "dependency", "existing"].includes(c.purpose))
      .map((c) => ({
        ...row,
        existingAuthorization: c.purpose === "existing",
        verification: undefined,
        sales: [c.sales],
        product: c.product,
        version: c.version,
        evidence: c.evidence,
      }));
  });
  const records = new Map<
    string,
    {
      entity: SaleEntity;
      page: SalePage;
      requirements: Set<string>;
      existingAuthorization?: boolean;
    }
  >();
  for (const row of rows)
    for (const name of row.sales) {
      const ids = new Set(row.evidence.map((e) => e.snapshotId));
      let candidates = pages
        .filter((p) => ids.has(p.id))
        .map((page) => ({ page, entity: parseSaleEntity(page.content) }))
        .filter((c) => c.entity.title === name);
      candidates = candidates.filter(
        (c) =>
          (!row.version ||
            c.entity.version.replace(/^v/i, "") ===
              row.version.replace(/^v/i, "")) &&
          (!row.product || c.entity.product === row.product),
      );
      if (candidates.length !== 1)
        throw new AppError(
          409,
          `销售项 ${name} 缺少唯一实体证据或引用了多个内容版本，请统一后导出`,
        );
      const { page, entity } = candidates[0];
      const key = JSON.stringify([
        entity.product,
        entity.version,
        entity.moduleId || entity.title,
      ]);
      const prior = records.get(key);
      if (
        prior &&
        (prior.page.hash !== page.hash || prior.entity.title !== entity.title)
      )
        throw new AppError(
          409,
          `销售项 ${name} 的实体版本存在冲突，请统一证据`,
        );
      if (prior) {
        prior.requirements.add(row.requirementId);
        prior.existingAuthorization ||= row.existingAuthorization;
      } else
        records.set(key, {
          page,
          entity,
          requirements: new Set([row.requirementId]),
          existingAuthorization: row.existingAuthorization,
        });
    }
  const missing = [
    ...new Set(
      [...records.values()].flatMap((r) =>
        r.entity.dependencies.filter(
          (d) =>
            ![...records.values()].some(
              (other) =>
                (other.entity.title === d ||
                  other.entity.moduleId === d ||
                  other.entity.title.replace(/[（(][^）)]*[）)]$/, "") === d ||
                  other.page.path.replace(/\.md$/, "").split("/").at(-1) ===
                    d ||
                  other.page.path
                    .replace(/\.md$/, "")
                    .endsWith(d.replace(/\.md$/, ""))) &&
                other.entity.product === r.entity.product &&
                other.entity.version === r.entity.version,
            ),
        ),
      ),
    ),
  ];
  if (missing.length)
    throw new AppError(
      409,
      `销售项实体声明的交付依赖尚未列入清单：${missing.join("、")}，请补充匹配与证据`,
    );
  return [...records.values()].filter((r) => !r.existingAuthorization);
}
