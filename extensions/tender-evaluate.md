```ty
/**
 * tender-evaluate — 评标助手扩展（纯工具层，不含业务逻辑）
 *
 * 工具：
 *   1. tender_discover  — 发现招标文件（input/ 或项目根目录），返回路径与隔离目录。
 *   2. tender_parse     — 解析招标文件为带行号的 source.md（支持 docx/pdf/xlsx/md/txt）。
 *   3. tender_report    — 读取 match-report.md 中的偏离 JSON，生成详细 HTML 报告。
 *   4. tender_status    — 查看环境状态（LLM Wiki 连通性、已有文件与报告）。
 *
 * 命令：
 *   /tender-evaluate <招标文件> — 触发完整评标工作流（注入提示词让 LLM 编排）。
 *
 * 隔离目录约定：
 *   - 每个招标文件对应 output/<slug>/，并发互不干扰。
 *   - 产出：source.md / parse-report.md / extraction-report.md / match-report.md / match-report.html
 *
 * 放置：.pi/extensions/tender-evaluate.ts（项目级，信任后自动加载，/reload 热重载）
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

// ============================================================
// 工具函数
// ============================================================

let PROJECT_ROOT: string | null = null;

function findProjectRoot(start: string): string {
  let dir = path.resolve(start);
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, ".pi")) || fs.existsSync(path.join(dir, "input"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(start);
}

function getRoot(ctx?: any): string {
  if (PROJECT_ROOT) return PROJECT_ROOT;
  PROJECT_ROOT = findProjectRoot(ctx?.cwd ?? process.cwd());
  return PROJECT_ROOT;
}

function slugify(name: string): string {
  const base = path.basename(name, path.extname(name));
  return (base.replace(/[\\/:*?"<>|\s]+/g, "_").replace(/^_+|_+$/g, "") || "tender").slice(0, 80);
}

function outDirFor(root: string, file: string): string {
  return path.join(root, "output", slugify(file));
}

function run(cmd: string, args: string[], cwd: string): string {
  try {
    return execFileSync(cmd, args, { cwd, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
  } catch (err: any) {
    return `[ERROR] ${err?.message ?? String(err)}`;
  }
}

const TENDER_EXTS = [".xlsx", ".xls", ".docx", ".doc", ".md", ".txt", ".pdf"];

function listTenderFiles(dir: string): Array<{ file: string; abs: string; mtime: number }> {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => !f.startsWith("~$") && !f.startsWith(".") && TENDER_EXTS.includes(path.extname(f).toLowerCase()))
    .map((f) => ({ file: f, abs: path.join(dir, f), mtime: fs.statSync(path.join(dir, f)).mtimeMs }));
}

function discoverInput(root: string, name?: string): { file: string; abs: string } | null {
  const candidates = [...listTenderFiles(path.join(root, "input")), ...listTenderFiles(root)]
    .sort((a, b) => b.mtime - a.mtime);
  if (name) {
    const trimmed = name.trim();
    const absPath = path.isAbsolute(trimmed) ? trimmed : path.resolve(root, trimmed);
    if (fs.existsSync(absPath) && fs.statSync(absPath).isFile() && TENDER_EXTS.includes(path.extname(absPath).toLowerCase())) {
      return { file: path.basename(absPath), abs: absPath };
    }
    const hit = candidates.find((f) => f.file.toLowerCase().includes(trimmed.toLowerCase()));
    return hit ?? null;
  }
  return candidates[0] ?? null;
}

// ============================================================
// 解析函数（供 tender_parse 工具调用）
// ============================================================

function parseXlsx(abs: string): { header: string[]; rows: string[][] } {
  const pyScript = `
import sys, json
sys.stdout.reconfigure(encoding="utf-8")
try:
    from openpyxl import load_workbook
except Exception as e:
    print(json.dumps({"error":"openpyxl missing: "+str(e)})); sys.exit(0)
wb = load_workbook(sys.argv[1], read_only=True, data_only=True)
ws = None
for name in wb.sheetnames:
    if "Wps" in name or "Reserved" in name: continue
    ws = wb[name]; break
if ws is None: ws = wb[wb.sheetnames[0]]
rows = []
for r in ws.iter_rows(values_only=True):
    rows.append(["" if c is None else str(c) for c in r])
print(json.dumps({"sheet":ws.title,"rows":rows}, ensure_ascii=False))
`;
  try {
    const out = execFileSync("python", ["-c", pyScript, abs], { encoding: "utf-8", env: { ...process.env, PYTHONIOENCODING: "utf-8" }, maxBuffer: 64 * 1024 * 1024 });
    const data = JSON.parse(out);
    if (data.error) return { header: [], rows: [] };
    const rows: string[][] = data.rows.filter((r: string[]) => r.some((c: string) => c.trim() !== ""));
    return { header: rows[0] ?? [], rows: rows.slice(1) };
  } catch { return { header: [], rows: [] }; }
}

function parseMarkdown(abs: string): { sections: Array<{ level: number; title: string; line: number }>; lines: string[] } {
  const content = fs.readFileSync(abs, "utf-8");
  const lines = content.split(/\r?\n/);
  const sections: Array<{ level: number; title: string; line: number }> = [];
  lines.forEach((l, i) => { const m = l.match(/^(#{1,6})\s+(.*)$/); if (m) sections.push({ level: m[1].length, title: m[2].trim(), line: i + 1 }); });
  return { sections, lines };
}

function parseDocx(abs: string): string[] {
  const pyScript = `
import sys, json
sys.stdout.reconfigure(encoding="utf-8")
items = []
try:
    from docx import Document
    d = Document(sys.argv[1])
    for p in d.paragraphs:
        t = p.text.strip()
        if t: items.append(t)
    for tb in d.tables:
        for row in tb.rows:
            cells = [c.text.strip() for c in row.cells]
            line = " | ".join(c for c in cells if c)
            if line: items.append(line)
    print(json.dumps(items, ensure_ascii=False))
except Exception as e:
    print(json.dumps([])); sys.exit(0)
`;
  try {
    const out = execFileSync("python", ["-c", pyScript, abs], { encoding: "utf-8", env: { ...process.env, PYTHONIOENCODING: "utf-8" }, maxBuffer: 64 * 1024 * 1024 });
    return JSON.parse(out);
  } catch { return []; }
}

function parsePdf(abs: string): Array<{ page: number; text: string }> {
  const pyScript = `
import sys, json
sys.stdout.reconfigure(encoding="utf-8")
try:
    import pdfplumber
    pages = []
    with pdfplumber.open(sys.argv[1]) as pdf:
        for pi, page in enumerate(pdf.pages):
            text = page.extract_text()
            if text:
                for line in text.split("\\n"):
                    line = line.strip()
                    if line: pages.append({"page":pi+1,"text":line})
    print(json.dumps(pages, ensure_ascii=False))
except ImportError:
    print(json.dumps({"error":"pdfplumber not installed. Run: pip install pdfplumber"}))
    sys.exit(0)
except Exception as e:
    print(json.dumps({"error":str(e)}))
    sys.exit(0)
`;
  try {
    const out = execFileSync("python", ["-c", pyScript, abs], { encoding: "utf-8", env: { ...process.env, PYTHONIOENCODING: "utf-8" }, maxBuffer: 64 * 1024 * 1024 });
    const parsed = JSON.parse(out);
    if (parsed.error) return [];
    return parsed;
  } catch { return []; }
}

// ============================================================
// HTML 报告生成（供 tender_report 工具调用）
// ============================================================

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function extractDeviationJson(matchMd: string): any | null {
  const m = matchMd.match(/<!--\s*DEVIATION_START\s*-->([\s\S]*?)<!--\s*DEVIATION_END\s*-->/);
  if (!m) return null;
  try { const obj = JSON.parse(m[1].trim()); return obj?.deviation_report ?? null; } catch { return null; }
}

function loadSalesDetail(root: string): Record<string, any> {
  try { const p = path.join(root, "output", "sales-detail.json"); if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { /* ignore */ }
  return {};
}

function renderDetailedHtml(dev: any, root: string): string {
  const modules: any[] = dev?.modules ?? [];
  const salesDetail = loadSalesDetail(root);
  const esc = escapeHtml;
  const badge = (lvl: string) =>
    lvl === "exact" ? '<span class="badge b-exact">正偏离</span>' :
    lvl === "partial" ? '<span class="badge b-partial">部分满足</span>' :
    '<span class="badge b-nomatch">负偏离</span>';
  const sublist = (items: string[] | undefined, cls: string, label: string) => {
    if (!items || !items.length) return "";
    const liCls = { ok: "sub-ok", hard: "sub-hard", no: "sub-no" }[cls] ?? "sub-ok";
    return `<div class="subgroup ${cls}"><div class="subtitle">${label}</div><ul>${items.map((x) => `<li class="${liCls}">${esc(x)}</li>`).join("")}</ul></div>`;
  };

  let totalItems = 0, exactCount = 0, partialCount = 0, nomatchCount = 0;
  const allNo: Array<{ mod: string; id: string; sum: string; no: string }> = [];
  for (const m of modules) {
    for (const it of m?.items ?? []) {
      totalItems++;
      const lvl = it.level ?? "";
      if (lvl === "exact") exactCount++; else if (lvl === "partial") partialCount++; else nomatchCount++;
      for (const x of it.no ?? []) allNo.push({ mod: m.name, id: it.id, sum: it.summary, no: x });
    }
  }

  let moduleHtml = "";
  for (const m of modules) {
    let rows = "";
    for (const it of m?.items ?? []) {
      const hasNo = (it.no ?? []).length > 0;
      const subs = sublist(it.ok, "ok", "满足") + sublist(it.hard, "hard", "勉强硬上") + sublist(it.no, "no", "不满足");
      const salesLinks = (it.sales || "").split(/[、,，]/).map((s: string) => s.trim()).filter(Boolean)
        .map((s: string) => { const has = salesDetail[s] ? "" : " no-detail"; return `<a class="sales-link${has}" data-sales="${esc(s)}" href="javascript:void(0)">${esc(s)}</a>`; }).join("<br>");
      rows += `<tr class="${hasNo ? " row-no" : ""}">
        <td class="tid">${esc(it.id)}</td><td class="summary raw-text">${esc(it.raw || it.summary || "")}</td>
        <td class="sales">${salesLinks}</td><td class="lvl">${badge(it.level)}</td>
        <td class="note">${esc(it.note)}</td><td class="evidence">${esc(it.evidence || "")}</td><td class="subs">${subs}</td></tr>`;
    }
    moduleHtml += `<div class="card module"><div class="mod-head"><h2>${esc(m.name)}</h2><div class="mod-meta">
      <span>匹配：${esc(m.sales)}</span><span>产品：${esc(m.product)}</span><span>模块级别：${badge(m.level)}</span><span>置信度：${esc(String(m.confidence))}</span></div></div>
      <table><thead><tr><th>编号</th><th>功能点（原始清单）</th><th>匹配销售项</th><th>偏离</th><th>结论说明</th><th>证据（知识库原文摘要）</th><th>满足度细分</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  const noHtml = allNo.length
    ? allNo.map((r) => `<div class="risk"><b>[${esc(r.id)}] ${esc(r.mod)}</b> — ${esc(r.sum)}<br><span class="no-text">不满足：${esc(r.no)}</span></div>`).join("")
    : "<p>无完全不满足项。</p>";
  const modTable = modules.map((m: any) => {
    const links = (m.sales || "").split(/[、,，]/).map((s: string) => s.trim()).filter(Boolean)
      .map((s: string) => { const has = salesDetail[s] ? "" : " no-detail"; return `<a class="sales-link${has}" data-sales="${esc(s)}" href="javascript:void(0)">${esc(s)}</a>`; }).join("<br>");
    return `<tr><td>${esc(m.name)}</td><td class="sales">${links}</td><td>${esc(m.product)}</td><td>${badge(m.level)}</td><td>${esc(String(m.confidence))}</td></tr>`;
  }).join("");

  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>评标匹配详细报告 · ${esc(dev?.source ?? "")}</title>
<style>:root{--exact:#1a7f37;--partial:#9a6700;--nomatch:#cf222e;--bg:#f6f8fa;--card:#fff;--border:#d0d7de}*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;background:var(--bg);color:#1f2328;line-height:1.6;padding:24px}
.container{max-width:1200px;margin:0 auto}header{background:linear-gradient(135deg,#1f3a5f,#2d6a8f);color:#fff;border-radius:12px;padding:28px 32px;margin-bottom:24px}
header h1{font-size:26px;margin-bottom:8px}header .meta{font-size:13px;opacity:.9}header .meta span{margin-right:18px}
.stats{display:flex;gap:16px;margin:20px 0;flex-wrap:wrap}.stat{flex:1;min-width:150px;background:var(--card);border:1px solid var(--border);border-radius:10px;padding:18px;text-align:center}
.stat .num{font-size:32px;font-weight:700}.stat .label{font-size:13px;color:#57606a;margin-top:4px}
.stat.exact .num{color:var(--exact)}.stat.partial .num{color:var(--partial)}.stat.nomatch .num{color:var(--nomatch)}
.card{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:22px 26px;margin-bottom:20px}.card h2{font-size:18px;margin-bottom:14px;border-bottom:2px solid #eaeef2;padding-bottom:8px}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:9px 10px;border-bottom:1px solid #eaeef2;vertical-align:top}th{background:#f6f8fa;font-weight:600;white-space:nowrap}
.badge{display:inline-block;padding:2px 10px;border-radius:20px;font-size:12px;font-weight:600;color:#fff;white-space:nowrap}.b-exact{background:var(--exact)}.b-partial{background:var(--partial)}.b-nomatch{background:var(--nomatch)}
.module{padding:18px 20px}.mod-head{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;border-bottom:2px solid #eaeef2;padding-bottom:10px;margin-bottom:12px}
.mod-head h2{border:none;margin:0;padding:0;font-size:17px}.mod-meta{font-size:12.5px;color:#57606a}.mod-meta span{margin-right:14px}
.tid{font-weight:600;white-space:nowrap;color:#57606a}.summary{min-width:220px}.raw-text{font-size:12.5px;line-height:1.7}.sales{color:#2d6a8f}
.sales-link{color:#2d6a8f;text-decoration:underline;cursor:pointer;font-weight:600}.sales-link:hover{color:#1f3a5f}.sales-link.no-detail{color:#8b949e;text-decoration:none;cursor:default;font-weight:400}
.note{color:#57606a;font-size:12.5px}.evidence{color:#1a3c6e;font-size:12px;line-height:1.7;min-width:240px}
.subs{min-width:200px}.subgroup{margin-top:4px}.subgroup .subtitle{font-size:11.5px;font-weight:700;margin-bottom:2px}
.subgroup.ok .subtitle{color:var(--exact)}.subgroup.hard .subtitle{color:#b08800}.subgroup.no .subtitle{color:var(--nomatch)}
.subgroup ul{margin:0;padding-left:16px}.subgroup li{font-size:12px}.subgroup.no li{color:var(--nomatch);font-weight:600}
tr.row-no{background:#fff0f0}tr.row-no td{border-bottom:1px solid #f5c6c6}
.risk{background:#fff8e6;border-left:4px solid var(--partial);padding:10px 14px;border-radius:6px;margin:8px 0;font-size:13.5px}.risk b{color:var(--partial)}.risk .no-text{color:var(--nomatch);font-weight:600}
.footer{text-align:center;color:#57606a;font-size:12px;margin-top:24px}code{background:#eef1f4;padding:1px 6px;border-radius:4px;font-size:12px;color:#24292f}.legend{font-size:12.5px;color:#57606a;margin-top:10px}
.modal-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:1000;align-items:center;justify-content:center;padding:20px}.modal-overlay.show{display:flex}
.modal{background:#fff;border-radius:12px;max-width:860px;width:100%;max-height:85vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,.3)}
.modal-head{display:flex;justify-content:space-between;align-items:center;padding:16px 22px;border-bottom:2px solid #eaeef2}.modal-head h3{font-size:17px;color:#1f3a5f}
.modal-close{background:none;border:none;font-size:24px;cursor:pointer;color:#57606a;line-height:1}.modal-close:hover{color:#1f2328}
.modal-body{padding:18px 22px;overflow-y:auto;font-size:13.5px;line-height:1.7}.modal-body .field{margin-bottom:10px}.modal-body .field .k{font-weight:700;color:#1f3a5f}
.modal-body .spec{margin-top:12px}.modal-body .spec .k{font-weight:700;color:#1f3a5f;display:block;margin-bottom:6px}
.modal-body .spec-text{background:#f6f8fa;border:1px solid #eaeef2;border-radius:8px;padding:12px 14px;white-space:pre-wrap;word-break:break-word}.modal-body .no-detail-tip{color:#8b949e;font-style:italic}
</style></head><body><div class="container">
<header><h1>评标产品匹配详细报告 · ${esc(dev?.source ?? "")}</h1><div class="meta"><span>🧩 功能模块：${modules.length} 个</span><span>📋 功能点：${totalItems} 条</span><span>🏷 主匹配产品：${esc(dev?.product ?? "")}</span></div></header>
<div class="stats"><div class="stat exact"><div class="num">${exactCount}</div><div class="label">正偏离（完全满足）</div></div><div class="stat partial"><div class="num">${partialCount}</div><div class="label">部分满足</div></div><div class="stat nomatch"><div class="num">${nomatchCount}</div><div class="label">负偏离（完全不满足）</div></div></div>
<div class="card"><h2>模块级匹配总览（${modules.length} 模块）</h2><table><thead><tr><th>模块</th><th>匹配销售项</th><th>产品/版本</th><th>模块级别</th><th>置信度</th></tr></thead><tbody>${modTable}</tbody></table><div class="legend">偏离定义：<span class="badge b-exact">正偏离</span> 功能完全满足 ｜ <span class="badge b-partial">部分满足</span> 细分满足/勉强硬上/不满足 ｜ <span class="badge b-nomatch">负偏离</span> 完全不满足</div></div>
<div class="card"><h2>⚠️ 不满足项汇总（高亮，需重点关注）</h2>${noHtml}</div>
<div class="card"><h2>逐功能点详细偏离分析</h2><p style="font-size:13px;color:#57606a;margin-bottom:12px">以下按模块逐一列出原始清单拆分出的功能点，标注匹配销售项与偏离类型；部分满足项进一步细分为「满足 / 勉强硬上 / 不满足」三档，<span style="color:var(--nomatch);font-weight:600">不满足项整行红色高亮</span>。</p>${moduleHtml}</div>
<div class="footer">评标助手 · 三步链式工作流 ｜ 证据引用见 output/match-report.md ｜ 生成时间：${new Date().toLocaleString()}</div></div>
<div class="modal-overlay" id="salesModal"><div class="modal"><div class="modal-head"><h3 id="salesModalTitle">销售项详情</h3><button class="modal-close" onclick="closeSalesModal()">&times;</button></div><div class="modal-body" id="salesModalBody"></div></div></div>
<script>const SALES_DETAIL=${JSON.stringify(salesDetail)};
function openSalesModal(n){const d=SALES_DETAIL[n];const t=document.getElementById('salesModalTitle');const b=document.getElementById('salesModalBody');
if(!d){t.textContent=n;b.innerHTML='<p class="no-detail-tip">知识库中未收录该销售项的原始描述，请在 output/sales-detail.json 或 LLM Wiki 知识库中核对。</p>'}
else{t.textContent=n+'（'+(d.module_id||'')+'）';const f=(k,v)=>v?'<div class="field"><span class="k">'+k+'：</span>'+v+'</div>':'';
let h=f('模块ID',d.module_id)+f('模块分类',d.category)+f('是否必选',d.required)+f('依赖销售项',d.dependency)+f('报价说明',d.quote);
if(d.description)h+='<div class="field"><span class="k">描述：</span>'+d.description+'</div>';
if(d.spec)h+='<div class="spec"><span class="k">技术规格：</span><div class="spec-text">'+d.spec+'</div></div>';b.innerHTML=h;}
document.getElementById('salesModal').classList.add('show')}
function closeSalesModal(){document.getElementById('salesModal').classList.remove('show')}
document.addEventListener('click',function(e){const l=e.target.closest('.sales-link');if(l&&!l.classList.contains('no-detail'))openSalesModal(l.getAttribute('data-sales'));if(e.target.classList&&e.target.classList.contains('modal-overlay'))closeSalesModal()});
document.addEventListener('keydown',function(e){if(e.key==='Escape')closeSalesModal()});</script></body></html>`;
}

// ============================================================
// 扩展入口
// ============================================================

export default function (pi: ExtensionAPI) {

  // ==========================================================
  // 工具 1：tender_status — 环境状态
  // ==========================================================
  pi.registerTool({
    name: "tender_status",
    label: "评标环境状态",
    description: "查看评标助手环境状态：LLM Wiki 服务连通性、input/ 目录下的招标文件、output/ 下各标的隔离目录及已有报告。用于评标前确认环境就绪。",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const root = getRoot(ctx);
      const status = run("node", [path.join(root, ".pi", "skills", "llm-wiki", "llm-wiki.mjs"), "status"], root);
      let service = "未知";
      try { const j = JSON.parse(status); service = j.ok ? `运行中 (${j.version}, 项目: ${j.currentProject?.name ?? "?"})` : "异常"; } catch { service = "无法解析"; }
      const inputs = [...listTenderFiles(path.join(root, "input")), ...listTenderFiles(root)].map((f) => f.file);
      const OUTPUT_DIR = path.join(root, "output");
      const jobLines: string[] = [];
      if (fs.existsSync(OUTPUT_DIR)) {
        for (const d of fs.readdirSync(OUTPUT_DIR)) {
          const dp = path.join(OUTPUT_DIR, d);
          if (!fs.statSync(dp).isDirectory()) continue;
          const reports = fs.readdirSync(dp).filter((f) => f.endsWith(".md") || f.endsWith(".html"));
          jobLines.push(`- **${d}/**：${reports.length ? reports.join("、") : "（尚无报告）"}`);
        }
      }
      const text = [
        `## 评标环境状态`, ``,
        `- **LLM Wiki 服务**：${service}`,
        `- **项目根目录**：${root}`,
        `- **可评标文件（input/ + 项目根目录）**：${inputs.length ? inputs.join("、") : "（空）"}`,
        `- **output/ 隔离目录**：${jobLines.length ? "\n" + jobLines.join("\n") : "（无）"}`,
        ``, `> 提示：输入「评标 <文件名>」即可对指定文件开始评标。`,
      ].join("\n");
      return { content: [{ type: "text", text }], details: {} };
    },
  });

  // ==========================================================
  // 工具 2：tender_parse — 解析招标文件为 source.md
  // 纯机械操作，不含任何业务判断
  // ==========================================================
  pi.registerTool({
    name: "tender_parse",
    label: "解析招标文件为 source.md",
    description: "将招标文件（docx/pdf/xlsx/md/txt）解析为带行号的 source.md，写入隔离目录。支持自动发现文件（input/ 或项目根目录）。返回解析摘要和 source.md 路径，供后续 Agent 引用原文行号。",
    parameters: Type.Object({
      file: Type.Optional(Type.String({ description: "文件名（可部分匹配，input/ 目录或项目根目录）。留空则自动取最新文件。" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const root = getRoot(ctx);
      const found = discoverInput(root, params.file);
      if (!found) return { content: [{ type: "text", text: `未找到招标文件。请确认文件存在于工作区内（可提供绝对路径或相对路径，或放入 input/ 目录 / 项目根目录）。` }], details: {} };

      const outDir = outDirFor(root, found.file);
      fs.mkdirSync(outDir, { recursive: true });
      const ext = path.extname(found.file).toLowerCase();
      let lines: string[] = [];
      let sourceMd = "";
      let summary = "";

      if (ext === ".xlsx") {
        const { header, rows } = parseXlsx(found.abs);
        const idxName = header.findIndex((h) => /设备名称|功能项|名称/.test(h));
        const idxSpec = header.findIndex((h) => /规格参数|技术要求|功能描述|描述/.test(h));
        const idxSeq = header.findIndex((h) => /序号/.test(h));
        lines = rows.map((r) => {
          const seq = idxSeq >= 0 ? r[idxSeq]?.trim() : "";
          const name = idxName >= 0 ? r[idxName]?.trim() : "";
          const spec = idxSpec >= 0 ? r[idxSpec]?.trim() : "";
          return `${seq ? `[${seq}] ` : ""}${name}${spec ? `：${spec}` : ""}`;
        }).filter((l) => l.trim());
        sourceMd = lines.map((l, i) => `${i + 1}. ${l}`).join("\n\n");
        summary = `工作表 ${header.join(" | ")}，有效数据 ${lines.length} 行`;
      } else if (ext === ".md" || ext === ".markdown" || ext === ".txt") {
        const { sections, lines: rawLines } = parseMarkdown(found.abs);
        lines = rawLines;
        sourceMd = `# 招标文件原文（带行号）\n\n> 源文件：${found.file}\n> 解析时间：${new Date().toISOString().slice(0, 10)}\n\n` +
          lines.map((l, i) => `${i + 1}. ${l}`).join("\n");
        summary = `共 ${lines.length} 行，章节 ${sections.length} 个：${sections.map((s) => s.title).join(" / ")}`;
      } else if (ext === ".docx") {
        lines = parseDocx(found.abs);
        sourceMd = `# 招标文件原文（带行号，从 docx 提取）\n\n> 源文件：${found.file}\n> 解析时间：${new Date().toISOString().slice(0, 10)}\n> 段落总数：${lines.length}\n\n` +
          lines.map((l, i) => `${i + 1}. ${l}`).join("\n\n");
        summary = `共 ${lines.length} 段有效内容（已用 python-docx 提取）`;
      } else if (ext === ".pdf") {
        const pages = parsePdf(found.abs);
        lines = pages.map((p) => p.text);
        sourceMd = `# 招标文件原文（带行号，从 PDF 提取）\n\n> 源文件：${found.file}\n> 解析时间：${new Date().toISOString().slice(0, 10)}\n> 行数：${lines.length}\n\n` +
          pages.map((p, i) => `${i + 1}. [第${p.page}页] ${p.text}`).join("\n\n");
        summary = `共 ${lines.length} 行有效内容（已用 pdfplumber 提取）`;
      } else {
        return { content: [{ type: "text", text: `暂不支持解析 ${ext} 格式，请先转换为 xlsx、md、docx 或 pdf。` }], details: {} };
      }

      const sourceMdPath = path.join(outDir, "source.md");
      fs.writeFileSync(sourceMdPath, sourceMd, "utf-8");

      const text = [
        `## 招标文件解析完成`,
        ``,
        `- **源文件**：${found.file}（${ext}）`,
        `- **解析摘要**：${summary}`,
        `- **source.md**：${sourceMdPath}（带行号，Agent 引用原文时请使用此文件的行号作为证据）`,
        `- **隔离输出目录**：${outDir}`,
        ``,
        `> 下一步：请调用 tender-parser Agent 对 source.md 进行文档解析（章节大纲 + 元数据 + 模块切分），产出 parse-report.md。`,
      ].join("\n");

      return { content: [{ type: "text", text }], details: { source: found.file, outDir, sourceMdPath, lineCount: lines.length } };
    },
  });

  // ==========================================================
  // 工具 3：tender_report — 生成 HTML 报告
  // ==========================================================
  pi.registerTool({
    name: "tender_report",
    label: "生成评标汇总 HTML 报告",
    description: "读取指定标的隔离目录 output/<标的>/ 下的 match-report.md，若含偏离分析 JSON（<!-- DEVIATION_START -->），则生成「总览 + 逐功能点偏离 + 不满足高亮」的详细 HTML 报告；否则回退为三份报告的简单汇总。file 参数指定标的（可传文件名或目录名），留空则取最新标的。",
    parameters: Type.Object({
      file: Type.Optional(Type.String({ description: "标的标识：招标文件名或 output/ 下的目录名（可部分匹配）。留空则取最新标的。" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const root = getRoot(ctx);
      const OUTPUT_DIR = path.join(root, "output");
      if (!fs.existsSync(OUTPUT_DIR)) return { content: [{ type: "text", text: "output/ 下暂无报告，请先完成评标流程。" }], details: {} };

      let targetDir: string | null = null;
      const dirs = fs.readdirSync(OUTPUT_DIR).filter((d) => fs.statSync(path.join(OUTPUT_DIR, d)).isDirectory());
      if (params.file) {
        const hit = dirs.find((d) => d.toLowerCase().includes(params.file!.toLowerCase()));
        if (hit) targetDir = path.join(OUTPUT_DIR, hit);
      }
      if (!targetDir && dirs.length) {
        targetDir = dirs.map((d) => ({ d, m: fs.statSync(path.join(OUTPUT_DIR, d)).mtimeMs })).sort((a, b) => b.m - a.m)[0].d;
        targetDir = path.join(OUTPUT_DIR, targetDir);
      }
      if (!targetDir) return { content: [{ type: "text", text: "output/ 下无标的隔离目录，请先完成评标流程。" }], details: {} };

      // 优先从 Excel/CSV 读取偏离数据
      const xlsxPath = path.join(targetDir, "match-report.xlsx");
      const csvPath = path.join(targetDir, "match-report.csv");
      let dev: any = null;

      if (fs.existsSync(csvPath)) {
        dev = parseDeviationCsv(fs.readFileSync(csvPath, "utf-8"));
      }

      // 回退：从 match-report.md 读取 JSON
      if (!dev) {
        const matchPath = path.join(targetDir, "match-report.md");
        if (fs.existsSync(matchPath)) dev = extractDeviationJson(fs.readFileSync(matchPath, "utf-8"));
      }

      if (dev && (dev.modules ?? []).length) {
        const html = renderDetailedHtml(dev, root);
        const out = path.join(targetDir, "match-report.html");
        fs.writeFileSync(out, html, "utf-8");
        const total = (dev.modules ?? []).reduce((n: number, m: any) => n + (m.items ?? []).length, 0);
        return { content: [{ type: "text", text: `已生成详细偏离分析报告：${out}\n（${dev.modules.length} 个模块，${total} 个功能点，含逐点偏离与不满足高亮）` }], details: { path: out, mode: "detailed", modules: dev.modules.length, items: total } };
      }

      // 回退：简单汇总
      const files = ["parse-report.md", "extraction-report.md", "match-report.md"];
      const parts: string[] = [];
      for (const f of files) {
        const p = path.join(targetDir, f);
        if (fs.existsSync(p)) parts.push(`<h2>${f}</h2><pre>${escapeHtml(fs.readFileSync(p, "utf-8"))}</pre>`);
      }
      if (!parts.length) return { content: [{ type: "text", text: `${targetDir} 下暂无报告，请先完成评标流程。` }], details: {} };
      const html = `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><title>评标汇总报告</title><style>body{font-family:system-ui,sans-serif;max-width:1100px;margin:20px auto;padding:0 16px;color:#222}h1{color:#1a3c6e}pre{background:#f6f8fa;padding:14px;border-radius:8px;overflow:auto;font-size:13px;line-height:1.5}h2{border-bottom:2px solid #d0d7de;padding-bottom:6px;margin-top:28px}</style></head><body><h1>📋 评标汇总报告</h1><p>生成时间：${new Date().toLocaleString()}</p>${parts.join("\n")}</body></html>`;
      const out = path.join(targetDir, "match-report.html");
      fs.writeFileSync(out, html, "utf-8");
      return { content: [{ type: "text", text: `已生成汇总报告：${out}（未含偏离数据，已回退为简单汇总）` }], details: { path: out, mode: "simple" } };
    },
  });
}

/** 从 CSV 解析偏离数据，转为 deviation_report 结构 */
function parseDeviationCsv(csv: string): any | null {
  try {
    const lines = csv.split(/\r?\n/);
    if (lines.length < 2) return null;
    // 解析表头
    const header = lines[0].split(",");
    const idxId = header.findIndex((h) => h.includes("编号"));
    const idxModule = header.findIndex((h) => h.includes("模块"));
    const idxSummary = header.findIndex((h) => h.includes("功能点"));
    const idxSales = header.findIndex((h) => h.includes("销售项"));
    const idxLevel = header.findIndex((h) => h.includes("偏离"));
    const idxOk = header.findIndex((h) => h.includes("满足"));
    const idxHard = header.findIndex((h) => h.includes("勉强"));
    const idxNo = header.findIndex((h) => h.includes("不满足"));
    const idxNote = header.findIndex((h) => h.includes("结论"));
    const idxEvidence = header.findIndex((h) => h.includes("证据"));

    const moduleMap = new Map<string, any>();
    for (let i = 1; i < lines.length; i++) {
      const cols = parseCsvLine(lines[i]);
      if (cols.length < 3) continue;
      const modName = (cols[idxModule] || "").trim();
      if (!modName) continue;

      if (!moduleMap.has(modName)) {
        moduleMap.set(modName, {
          name: modName,
          sales: "",
          product: "",
          level: "partial",
          confidence: 0,
          items: [],
        });
      }
      const mod = moduleMap.get(modName)!;
      const level = (cols[idxLevel] || "partial").trim();
      mod.items.push({
        id: (cols[idxId] || "").trim(),
        summary: (cols[idxSummary] || "").trim(),
        sales: (cols[idxSales] || "").trim(),
        level: level || "partial",
        note: (cols[idxNote] || "").trim(),
        evidence: (cols[idxEvidence] || "").trim(),
        ok: splitLines(cols[idxOk]),
        hard: splitLines(cols[idxHard]),
        no: splitLines(cols[idxNo]),
      });
    }

    const modules = [...moduleMap.values()];
    // 计算模块级别
    for (const m of modules) {
      let exact = 0, partial = 0, nomatch = 0;
      for (const it of m.items) {
        if (it.level === "exact") exact++;
        else if (it.level === "no_match") nomatch++;
        else partial++;
      }
      m.confidence = m.items.length > 0 ? exact / m.items.length : 0;
      m.level = nomatch > exact && nomatch > partial ? "no_match" : exact >= partial ? "exact" : "partial";
    }

    return {
      source: "",
      product: "",
      product_rationale: "",
      modules,
    };
  } catch {
    return null;
  }
}

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (ch === "," && !inQuotes) { result.push(current); current = ""; continue; }
    current += ch;
  }
  result.push(current);
  return result;
}

function splitLines(val: string | undefined): string[] {
  if (!val || !val.trim()) return [];
  return val.split(/\n/).map((s) => s.trim()).filter(Boolean);
}
```

