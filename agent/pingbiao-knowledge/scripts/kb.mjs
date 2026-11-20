import { parseArgs } from "node:util";
const [command, ...args] = process.argv.slice(2);
async function main() {
  const options = {
    version: { type: "string" },
    cursor: { type: "string" },
    limit: { type: "string" },
    full: { type: "boolean" },
    mode: { type: "string" },
    topK: { type: "string" },
    minSimilarity: { type: "string" },
  };
  const { values: v, positionals } = parseArgs({
    args,
    options,
    allowPositionals: true,
  });
  if (!process.env.PINGBIAO_URL || !process.env.PINGBIAO_TOKEN)
    throw Error("请设置 PINGBIAO_URL 和 PINGBIAO_TOKEN");
  const url = new URL("/api/knowledge/skill/", process.env.PINGBIAO_URL);
  let route, body;
  if (command === "products") route = "products";
  else if (command === "catalog" && v.version) {
    const params = new URLSearchParams({
      versionId: v.version,
      view: v.full ? "full" : "summary",
    });
    if (v.limit) params.set("limit", v.limit);
    if (v.cursor) params.set("cursor", v.cursor);
    route = "catalog?" + params;
  } else if (command === "items" && positionals.length) {
    route = "items";
    body = { ids: positionals, versionId: v.version };
  } else if (command === "search" && positionals.length) {
    route = "search";
    body = {
      query: positionals.join(" "),
      mode: v.mode,
      versionIds: v.version ? [v.version] : [],
      topK: v.topK ? Number(v.topK) : undefined,
      minSimilarity: v.minSimilarity ? Number(v.minSimilarity) : undefined,
    };
  } else
    throw Error(
      "用法见 SKILL.md：products | catalog --version ID | items ID... | search 需求",
    );
  const res = await fetch(new URL(route, url), {
    method: body ? "POST" : "GET",
    redirect: "error",
    headers: {
      Authorization: "Bearer " + process.env.PINGBIAO_TOKEN,
      "X-Workspace-Request": "1",
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(120000),
  });
  const data = await res.json();
  if (!res.ok)
    throw Error("HTTP " + res.status + " " + (data.error ?? "请求失败"));
  console.log(JSON.stringify(data));
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
