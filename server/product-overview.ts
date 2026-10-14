import { posix } from "node:path";
const labels = [
  "产品标识",
  "产品名称",
  "产品类目",
  "产品线",
  "产品部门",
  "所属部门",
  "负责人",
  "维护人",
  "产品描述",
  "产品档案",
];
const normalized = (value: string) =>
  value.toLowerCase().replace(/[\s_-]/g, "");
export function overviewProduct(
  content: string,
  choice: { name: string; path: string },
) {
  const clean = content
    .replace(/\*\*|`/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  const starts = [...clean.matchAll(/产品标识\s*[:：]?\s*/g)];
  const matches = [];
  for (let i = 0; i < starts.length; i++) {
    const block = clean.slice(
      starts[i].index,
      starts[i + 1]?.index ?? clean.length,
    );
    const field = (name: string) => {
      const pattern = new RegExp(
        `${name}\\s*[:：]?\\s*(.*?)(?=\\s*(?:[·｜|;；]\\s*|\\n|\\s+)(?:${labels.join("|")})|\\n|$)`,
        "s",
      );
      return (
        block
          .match(pattern)?.[1]
          ?.replace(/[·｜|;；。\s]+$/g, "")
          .trim() ?? ""
      );
    };
    const productId = field("产品标识"),
      productName = field("产品名称");
    const aliases = [choice.name, posix.basename(choice.path, ".md")]
      .map(normalized)
      .filter(Boolean);
    if (
      ![productId, productName].some(
        (value) => value && aliases.includes(normalized(value)),
      )
    )
      continue;
    matches.push({
      productId,
      productName,
      productLine: field("产品线") || field("产品类目"),
      department: field("产品部门") || field("所属部门"),
      owner: field("负责人") || field("维护人"),
    });
  }
  // Ambiguous product records require model evidence rather than guessing a department/owner.
  return matches.length === 1 ? matches[0] : undefined;
}
