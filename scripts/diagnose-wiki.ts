import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";

const options = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  if (!process.argv[i].startsWith("--") || !process.argv[i + 1])
    throw new Error("参数格式：--参数 值");
  options.set(process.argv[i].slice(2), process.argv[i + 1]);
}
const required = (name: string) => {
  const value = options.get(name);
  if (!value) throw new Error(`缺少 --${name}`);
  return value;
};
const wikiUrl = required("wiki-url"),
  wikiProject = required("wiki-project");
const product = {
  name: required("product-name"),
  path: required("product-path"),
  version: required("version"),
};
const query = options.get("query") ?? "视频";
const url = new URL(wikiUrl);
if (url.username || url.password || url.search || url.hash)
  throw new Error("Wiki URL 不能包含凭据、参数或 fragment");
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "pid-wiki-diagnostic-"));
process.env.DATABASE_URL = "";
const token = process.env.LLM_WIKI_API_TOKEN ?? "";
const redact = (value: string) =>
  token ? value.split(token).join("[REDACTED]") : value;
const stages: Record<string, unknown>[] = [];
const requests: Record<string, unknown>[] = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (...args: Parameters<typeof fetch>) => {
  const requestUrl = new URL(String(args[0]));
  const started = Date.now();
  try {
    const response = await originalFetch(...args);
    requests.push({
      path: requestUrl.pathname + requestUrl.search,
      status: response.status,
      elapsedMs: Date.now() - started,
    });
    return response;
  } catch (error) {
    requests.push({
      path: requestUrl.pathname + requestUrl.search,
      elapsedMs: Date.now() - started,
      error: (error as Error).message,
    });
    throw error;
  }
};
let revision = "unknown";
try {
  revision = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
} catch {
  /* Source archive. */
}
const report: Record<string, unknown> = {
  startedAt: new Date().toISOString(),
  revision,
  node: process.version,
  wikiUrl,
  wikiProject,
  product,
  query,
  isolated: true,
  stages,
  requests,
};
const output = resolve(
  options.get("output") ?? `data/diagnostics/wiki-${Date.now()}.json`,
);
const persist = () => {
  mkdirSync(resolve(output, ".."), { recursive: true });
  writeFileSync(output, redact(JSON.stringify(report, null, 2)), "utf8");
};
const stage = async <T>(
  name: string,
  run: () => Promise<T>,
): Promise<T | undefined> => {
  console.log(`[开始] ${name}`);
  const started = Date.now();
  try {
    const result = await run();
    stages.push({ name, ok: true, elapsedMs: Date.now() - started, result });
    console.log(`[通过] ${name} (${Date.now() - started}ms)`);
    persist();
    return result;
  } catch (error) {
    const e = error as Error & { statusCode?: number };
    stages.push({
      name,
      ok: false,
      elapsedMs: Date.now() - started,
      error: { message: e.message, statusCode: e.statusCode, stack: e.stack },
    });
    console.log(`[失败] ${name}: ${redact(e.message)}`);
    persist();
    return undefined;
  }
};
const { openDatabase, migrate } = await import("../server/db.js");
const { saveSettings } = await import("../server/settings.js");
const { WikiClient, snapshotPage, wikiFilePaths } =
  await import("../server/wiki.js");
const { createTools } = await import("../server/tools.js");
const { productVersionList } = await import("../server/product-search.js");
const { parseSaleEntity } = await import("../server/sale-entity.js");
const { enforceProductScope } = await import("../server/product-scope.js");
const { selectProducts } = await import("../server/product-scope.js");
const db = await openDatabase("", "memory://");
try {
  await migrate(db);
  await saveSettings(db, { wikiBaseUrl: wikiUrl, wikiToken: token });
  const userId = randomUUID(),
    projectId = randomUUID(),
    conversationId = randomUUID(),
    runId = randomUUID();
  await db.query(
    "INSERT INTO users(id,username,display_name,password_hash,role) VALUES($1,'diagnostic','诊断','unused','admin')",
    [userId],
  );
  await db.query(
    "INSERT INTO projects(id,name,wiki_project_id,owner_id) VALUES($1,'临时诊断',$2,$3)",
    [projectId, wikiProject, userId],
  );
  await db.query(
    "INSERT INTO conversations(id,project_id,title) VALUES($1,$2,'诊断')",
    [conversationId, projectId],
  );
  await db.query(
    "INSERT INTO runs(id,conversation_id,project_id,user_id,input,idempotency_key,status) VALUES($1,$2,$3,$4,'诊断',$5,'completed')",
    [runId, conversationId, projectId, userId, randomUUID()],
  );
  await db.query(
    "INSERT INTO requirements(id,project_id,data,confirmed) VALUES('T-1',$1,$2,true)",
    [projectId, JSON.stringify({ raw: query })],
  );
  const wiki = new WikiClient(db);
  await stage("Wiki 文件清单原始格式及规范化", async () => {
    const raw = await wiki.request(
      `/api/v1/projects/${encodeURIComponent(wikiProject)}/files?root=wiki&recursive=true&maxFiles=10000`,
    );
    const paths = wikiFilePaths(raw);
    return { raw, normalizedCount: paths.length, normalizedPaths: paths };
  });
  const tools = createTools({
    db,
    projectId,
    conversationId,
    runId,
    userId,
    emit: async () => {},
  });
  report.tools = tools.map((t) => t.name);
  const invoke = async (name: string, args: Record<string, unknown>) => {
    const tool = tools.find((t) => t.name === name);
    if (!tool) throw new Error(`工具未注册：${name}`);
    const result = await tool.execute(randomUUID(), args);
    return JSON.parse(
      result.content
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join(""),
    );
  };
  await stage("wiki_read 产品页", () =>
    invoke("wiki_read", { path: product.path, start: 1, count: 200 }),
  );
  await stage("产品页所选版本列表", async () => {
    const content = await wiki.read(wikiProject, product.path);
    await snapshotPage(db, projectId, product.path, content);
    return {
      entity: parseSaleEntity(content),
      selectedVersionList: productVersionList(content, product.version),
    };
  });
  await selectProducts(db, projectId, userId, {
    expectedRevision: 1,
    selected: [product],
  });
  let offset = 0,
    complete = false;
  const sales: { path: string; snapshotId: string; title: string }[] = [];
  for (let page = 0; page < 200; page++) {
    const result = await stage(`wiki_product_catalog offset=${offset}`, () =>
      invoke("wiki_product_catalog", { offset, count: 25 }),
    );
    if (!result) break;
    sales.push(...result.items);
    if (result.complete) {
      complete = true;
      break;
    }
    if (result.nextOffset <= offset) throw new Error("目录分页没有前进");
    offset = result.nextOffset;
  }
  report.catalogComplete = complete;
  report.saleCount = sales.length;
  await stage("wiki_search T-1", () =>
    invoke("wiki_search", { requirementId: "T-1", query, topK: 5 }),
  );
  // Exercise the real save_assessments product/evidence membership gate without inventing an assessment.
  for (const sale of sales.slice(0, 3)) {
    await stage(`save_assessments 入库范围校验：${sale.title}`, async () => {
      const revision = await enforceProductScope(db, projectId, {
        product: product.name,
        version: product.version,
        sales: [sale.title],
        evidence: [
          { snapshotId: sale.snapshotId, lineStart: 1, lineEnd: 1, quote: "" },
        ],
      } as Parameters<typeof enforceProductScope>[2]);
      return {
        path: sale.path,
        scopeRevision: revision,
        validated: true,
        assessmentWritten: false,
      };
    });
  }
  report.validationNote =
    "测试了 save_assessments 使用的产品/版本/销售项范围校验；未生成或写入评估结论，不代表完整评估 payload 校验已通过。";
} catch (error) {
  report.fatal = {
    message: (error as Error).message,
    stack: (error as Error).stack,
  };
} finally {
  await db.close();
  report.finishedAt = new Date().toISOString();
  persist();
  const failed =
    Boolean(report.fatal) ||
    stages.some((s) => s.ok === false) ||
    report.catalogComplete !== true;
  console.log(`诊断${failed ? "存在失败" : "通过"}，报告：${output}`);
  process.exitCode = failed ? 1 : 0;
}
