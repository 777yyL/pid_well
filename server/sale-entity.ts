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
  dependencies?: string[];
  mustSelect?: string[];
  level?: AssessmentInput["level"];
  verification?: AssessmentInput["verification"];
  sales: string[];
  product: string;
  version: string;
  requirementId: string;
  evidence: { snapshotId: string }[];
}
export type CollectedSale = {
  entity: SaleEntity;
  page: SalePage;
  requirements: Set<string>;
  existingAuthorization?: boolean;
};
export type ComponentReuse = {
  requirementId: string;
  product: string;
  version: string;
  sales: string;
  source: string;
  reason: string;
};
const identityText = (value: string) =>
  value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s_-]/g, "");
const versionText = (value: string) =>
  value.trim().replace(/^v/i, "").toLowerCase();
function matchesDependency(r: CollectedSale, value: string) {
  return [
    r.entity.title,
    r.entity.moduleId,
    r.entity.title.replace(/[（(][^）)]*[）)]$/, ""),
    r.page.path,
    r.page.path.replace(/\.md$/, ""),
    r.page.path.replace(/\.md$/, "").split("/").at(-1),
  ].some((alias) => alias === value.replace(/\.md$/, "") || alias === value);
}

// An assessment can be exported with procurement issues; unresolved entities are never guessed.
export function summarizeSales(input: SaleMatch[], pages: SalePage[]) {
  type Selection = SaleMatch & {
    entityPath?: string;
    moduleId?: string;
    reuseSource?: string;
    reuseTarget?: string;
    reuseValid?: boolean;
    reuseReason?: string;
  };
  const issues: string[] = [];
  const reused: ComponentReuse[] = [];
  const rows: Selection[] = input.flatMap((row): Selection[] => {
    if (row.level === "unknown" || row.level === "no_match") return [];
    if (!row.verification) return [row];
    const v = row.verification;
    return v.contributions
      .filter((c) => ["purchase", "dependency", "existing"].includes(c.purpose))
      .map((c) => {
        const target = v.contributions.find((t) => t.id === c.reuseOf);
        const valid =
          !c.reuseOf ||
          (c.purpose === "existing" &&
            !!target &&
            target.id !== c.id &&
            !target.reuseOf &&
            ["purchase", "dependency", "existing"].includes(target.purpose) &&
            ((target.product === c.product &&
              target.version === c.version &&
              target.path === c.path &&
              target.moduleId === c.moduleId) ||
              v.integrations.some(
                (i) =>
                  i.confirmed &&
                  i.evidence.length &&
                  i.authorization.trim() &&
                  ((i.from === c.id && i.to === target.id) ||
                    (i.to === c.id && i.from === target.id)),
              )));
        return {
          ...row,
          verification: undefined,
          sales: [c.sales],
          product: c.product,
          version: c.version,
          evidence: c.evidence,
          entityPath: c.path,
          moduleId: c.moduleId,
          existingAuthorization: c.purpose === "existing",
          reuseSource: target
            ? `${target.product} ${target.version} / ${target.sales} (${target.path})`
            : undefined,
          reuseTarget: target?.path,
          reuseValid: valid,
          reuseReason: c.reason,
        };
      });
  });
  const records = new Map<string, CollectedSale>();
  const conflicting = new Set<string>();
  const sourceVersions = new Map<
    string,
    { hash: string; requirements: Set<string> }
  >();
  const conflictingSources = new Set<string>();
  const purchase = new Set<string>(),
    existing = new Set<string>();
  for (const row of rows)
    for (const name of row.sales) {
      const context = `${row.requirementId} · ${row.product} ${row.version} / ${name}`;
      const ids = new Set(row.evidence.map((e) => e.snapshotId));
      const candidates = pages
        .filter(
          (p) =>
            ids.has(p.id) && (!row.entityPath || p.path === row.entityPath),
        )
        .flatMap((page) => {
          try {
            return [{ page, entity: parseSaleEntity(page.content) }];
          } catch {
            issues.push(
              `${context}：实体元数据无法解析，路径 ${page.path}，快照 ${page.id}；未纳入采购清单。`,
            );
            return [];
          }
        })
        .filter(
          (c) =>
            c.entity.title === name &&
            (!row.moduleId || c.entity.moduleId === row.moduleId) &&
            (!row.version ||
              versionText(c.entity.version) === versionText(row.version)) &&
            (!row.product ||
              identityText(c.entity.product) === identityText(row.product)),
        );
      const equivalent = new Map(
        candidates.map((c) => [JSON.stringify([c.page.path, c.page.hash]), c]),
      );
      if (equivalent.size !== 1) {
        const paths =
          pages
            .filter((p) => ids.has(p.id))
            .map((p) => `${p.path} [${p.id}; ${p.hash.slice(0, 12)}]`)
            .join("、") || "无实体快照";
        issues.push(
          `${context}：${equivalent.size ? "引用了多个内容版本或多个实体，无法唯一定位" : "实体未匹配，请核对路径、模块标识、产品与版本"}。${row.entityPath ? `指定路径 ${row.entityPath}。` : ""}引用：${paths}`,
        );
        // Remove an earlier selection too, rather than silently retaining one side of a conflict.
        for (const c of candidates) {
          const key = JSON.stringify([
            identityText(c.entity.product),
            versionText(c.entity.version),
            c.entity.moduleId || c.entity.title,
            c.page.path,
          ]);
          records.delete(key);
          conflicting.add(key);
          conflictingSources.add(
            JSON.stringify([
              identityText(c.entity.product),
              versionText(c.entity.version),
              c.page.path,
            ]),
          );
        }
        continue;
      }
      const { page, entity } = [...equivalent.values()][0];
      const sourceKey = JSON.stringify([
        identityText(entity.product),
        versionText(entity.version),
        page.path,
      ]);
      if (conflictingSources.has(sourceKey)) continue;
      const previousSource = sourceVersions.get(sourceKey);
      if (previousSource && previousSource.hash !== page.hash) {
        issues.push(
          `${context}：同一实体存在多个内容版本，与 ${[...previousSource.requirements].join("、")} 冲突。路径 ${page.path}；内容哈希 ${previousSource.hash.slice(0, 12)}、${page.hash.slice(0, 12)}，请统一采购依据。`,
        );
        for (const [oldKey, old] of records)
          if (
            old.page.path === page.path &&
            identityText(old.entity.product) === identityText(entity.product) &&
            versionText(old.entity.version) === versionText(entity.version)
          ) {
            records.delete(oldKey);
            conflicting.add(oldKey);
          }
        conflictingSources.add(sourceKey);
        continue;
      }
      if (previousSource) previousSource.requirements.add(row.requirementId);
      else
        sourceVersions.set(sourceKey, {
          hash: page.hash,
          requirements: new Set([row.requirementId]),
        });
      const key = JSON.stringify([
        identityText(entity.product),
        versionText(entity.version),
        entity.moduleId || entity.title,
        page.path,
      ]);
      if (conflicting.has(key)) continue;
      const prior = records.get(key);
      if (
        prior &&
        (prior.page.hash !== page.hash || prior.entity.title !== entity.title)
      ) {
        issues.push(
          `${context}：同一实体存在多个内容版本，与 ${[...prior.requirements].join("、")} 冲突。路径 ${page.path}；快照 ${prior.page.id} [${prior.page.hash.slice(0, 12)}]、${page.id} [${page.hash.slice(0, 12)}]，请核实后统一采购依据。`,
        );
        records.delete(key);
        conflicting.add(key);
        continue;
      }
      if (row.existingAuthorization) existing.add(key);
      else purchase.add(key);
      if (prior) prior.requirements.add(row.requirementId);
      else
        records.set(key, {
          page,
          entity,
          requirements: new Set([row.requirementId]),
          existingAuthorization: !!row.existingAuthorization,
        });
      if (row.reuseSource && row.reuseValid)
        reused.push({
          requirementId: row.requirementId,
          product: row.product,
          version: row.version,
          sales: name,
          source: row.reuseSource,
          reason: row.reuseReason || "",
        });
      if (row.reuseValid === false)
        issues.push(
          `${context}：组件复用来源或授权依据未确认，不能视为已解决交付依赖。`,
        );
    }
  const all = [...records.values()];
  const validPaths = new Set(all.map((r) => r.page.path));
  const confirmedReuse = reused.filter((r) => {
    const source = rows.find(
      (s) =>
        s.requirementId === r.requirementId &&
        s.reuseSource === r.source &&
        s.sales.includes(r.sales),
    );
    if (source?.reuseTarget && validPaths.has(source.reuseTarget)) return true;
    issues.push(
      `${r.requirementId} · ${r.product} / ${r.sales}：复用来源实体存在歧义，需核实。`,
    );
    return false;
  });
  const reusedPaths = new Set(
    rows
      .filter(
        (r) =>
          r.reuseSource &&
          confirmedReuse.some(
            (c) =>
              c.requirementId === r.requirementId &&
              c.source === r.reuseSource &&
              r.sales.includes(c.sales),
          ),
      )
      .map((r) => r.entityPath),
  );
  for (const [key, record] of records) {
    if (existing.has(key) && purchase.has(key))
      issues.push(
        `${[...record.requirements].join("、")} · ${record.entity.product} ${record.entity.version} / ${record.entity.title}：同时记录新增采购与已有授权，请核定实际授权范围；保留采购行，不自动扣减。路径 ${record.page.path}`,
      );
    record.existingAuthorization = existing.has(key) && !purchase.has(key);
    for (const d of record.existingAuthorization &&
    reusedPaths.has(record.page.path)
      ? []
      : record.entity.dependencies)
      if (
        !all.some(
          (other) =>
            matchesDependency(other, d) &&
            identityText(other.entity.product) ===
              identityText(record.entity.product) &&
            versionText(other.entity.version) ===
              versionText(record.entity.version),
        )
      )
        issues.push(
          `${[...record.requirements].join("、")} · ${record.entity.product} ${record.entity.version} / ${record.entity.title}：交付依赖 ${d} 尚未列入同产品版本清单。跨产品同名组件不视为自动复用，需记录已有授权及确认复用来源。`,
        );
  }
  for (const row of input.filter(
    (r) => r.level !== "unknown" && r.level !== "no_match",
  ))
    for (const d of [...(row.dependencies || []), ...(row.mustSelect || [])]) {
      // Legacy declarations have no contribution identity; report the uncertainty instead of guessing across products.
      if (
        !all.some(
          (other) =>
            matchesDependency(other, d) &&
            (!!row.verification ||
              identityText(other.entity.product) ===
                identityText(row.product)) &&
            (!!row.verification ||
              !row.version ||
              versionText(other.entity.version) === versionText(row.version)),
        )
      )
        issues.push(
          `${row.requirementId} · ${row.product} ${row.version}：声明的交付依赖或必选项 ${d} 待核实（跨产品需明确复用授权）。`,
        );
    }
  return {
    sales: all.filter((r) => !r.existingAuthorization),
    issues: [...new Set(issues)],
    reused: confirmedReuse,
  };
}
export function collectSales(
  rows: SaleMatch[],
  pages: SalePage[],
): CollectedSale[] {
  const result = summarizeSales(rows, pages);
  if (result.issues.length)
    throw new AppError(409, `采购清单尚未核定：${result.issues.join("\n")}`);
  return result.sales;
}
