```
name: tender-evaluate
description: 评标助手完整工作流：文档解析 → 信息抽取 → 产品匹配。对上传的招标文件自动执行三步链式处理并产出可审计的匹配报告。用户通过自然语言发起（如"评标 <文件名>"），产出写入隔离目录 output/<标的>/，支持多个招标并发评标。
```

# 评标助手工作流（tender-evaluate）

对招标文件执行三步链式处理，产出可审计的匹配报告。每一步的输出作为下一步输入。

思考过程用中文进行输出！！！！

## 触发方式

用户通过自然语言发起评标，例如：

- `评标 <招标文件>`
- `对 <招标文件> 执行评标`
- `评估 input/xxx.docx`

收到此类请求后，按以下流程执行。若用户未指定文件，先调用 `tender_status` 查看可用文件，让用户选择。

## 可用工具

| 工具            | 用途                                           | 何时调用                           |
| --------------- | ---------------------------------------------- | ---------------------------------- |
| `tender_parse`  | 解析招标文件为带行号的 `source.md`             | **第一步必须调用**，传入招标文件名 |
| `tender_report` | 读取 match-report.md 偏离 JSON，生成 HTML 报告 | 收尾阶段调用                       |
| `tender_status` | 查看环境状态（LLM Wiki 连通性、已有文件）      | 可选，排查问题时调用               |

## 隔离目录约定

- 每个招标文件对应独立目录：`output/<文件名去扩展名去特殊字符>/`
- 该目录下固定产出：
  - `source.md`（带行号的招标文件原文）
  - `parse-report.md`（解析报告）
  - `extraction-report.md`（抽取报告）
  - `match-report.md`（匹配报告：产品选择 + 匹配总览 + 结论 + 复核报告）
  - `match-report.csv`（偏离分析明细表，用于复核和 HTML 生成）
  - `match-report.xlsx`（配置清单，按模板格式，可直接提交）
  - `match-report.html`（HTML 汇总报告）
- 本次会话的标的目录已由命令创建，**所有落盘必须写入该隔离目录**，不得写回 `output/` 根目录，以免与其他并发评标冲突。

## 步骤 0：解析招标文件（机械步骤）

**调用 `tender_parse` 工具**，传入招标文件名。工具会：

- 自动发现文件（input/ 或项目根目录）
- 解析为带行号的 `source.md`（支持 docx/pdf/xlsx/md/txt）
- 返回 `source.md` 路径和隔离目录路径

## 步骤 1：文档解析（tender-parser Agent，Scout）

调用 `tender-parser` Agent 解析招标文件：

- 输入：步骤 0 返回的 `source.md` 路径 + 原始招标文件路径
- 产出：章节大纲 + 元数据（含 source.md 行号证据）+ 模块切分（含行号范围）
- 落盘：`output/<标的>/parse-report.md`
- 人工确认：无异议后进入下一步

## 步骤 2：信息抽取（tender-extractor Agent，Planner）

调用 `tender-extractor` Agent：

- 输入：步骤 1 的解析输出 + `output/<标的>/source.md`
- 产出：结构化抽取报告（基本要求 / 资质要求 / 技术要求 / 评分办法），每字段附 source.md 行号证据
- **评分办法不可遗漏**：价格分权重、技术分权重、评分细则表
- 落盘：`output/<标的>/extraction-report.md`

## 步骤 3：产品匹配（product-matcher Agent，Smith）

调用 `product-matcher` Agent，**严格按三步流程执行**：

### 3.0 通读总览，确定产品（必须先做）

```bash
cd .pi/skills/llm-wiki && node llm-wiki.mjs read wiki/overview.md
```

总览列出 9 个产品及其业务领域。根据招标清单的功能点特征选择产品：

| 招标特征                                                  | 推荐产品                    |
| --------------------------------------------------------- | --------------------------- |
| 智慧园区/楼宇/企业综合管理（安防+通行+消费+后勤+AR+三维） | AIoTPNP                     |
| 纯安防（视频+门禁+报警+访客）                             | iSecure Center              |
| 讯问/留置/看护                                            | InfovisionInterrogation CDI |
| 停车管理                                                  | InfovisioniParkPlatform     |
| 园区可视化                                                | InfovisionPVIA              |
| 能效管理                                                  | InfoComCEMS                 |
| 高校安全                                                  | InfovisioniColleges-Safety  |
| 高速交通                                                  | InfovisionHCM-Highway       |
| 办案系统                                                  | InfovisionInterrogation-PS  |

**产品组合**：如果主体是某产品但个别功能点超出范围，标注为"主产品 + 集成 X 产品的 Y 模块"。

### 3.1 读取产品页，获取业务分类导航

```bash
cd .pi/skills/llm-wiki && node llm-wiki.mjs read wiki/entities/products/<产品>.md
```

产品页包含该产品所有业务分类和销售项清单，是逐条匹配的"地图"。

### 3.2 逐条匹配

- 对每个招标功能点，先在产品页分类索引中定位业务分类，再用 search 检索销售项详情页
- 过程：`search --content` → `read` 核对技术规格
- **匹配时必须结合项目建设背景**（从 parse-report.md 的「项目建设背景」章节获取）
- **功能点广度与深度扩展**：一个功能点往往隐含多个销售项需求，不能只匹配表面销售项
  - 需求列举了多个子系统 → 每个子系统都要匹配对应的业务销售项
  - 需求说了"统一接入/纳管" → 接入层 + 各业务层都要匹配
  - 需求说了"与 XX 对接" → 接口层 + XX 业务层都要匹配
  - 一个功能点可以对应多个销售项，CSV/Excel 中用多行表示（同一编号，不同销售项），后续去重
- 产出：
  - `match-report.md`（产品选择 + 匹配总览 + 结论）
  - `match-report.csv`（偏离分析明细表）
  - `match-report.xlsx`（两个 Sheet：功能点匹配报告 + 销售项清单）

### 步骤 3 关键规则：匹配的是销售项，不是组件能力

**这是匹配准确性的核心，必须严格遵守：**

1. **匹配对象是销售项（Sale Item），不是组件能力（Component）**
   - 匹配列填的是产品的**销售项名称**（如「视频监控」「门禁管理」「事件中心(高级版)」），而不是组件 ID 或模块能力名称（如 `Infovision_iSee-VMS`、`vms`）
   - 销售项来源：产品页的销售项清单，每个产品有固定的销售项列表
   - 必须先通读销售项清单，了解该产品有哪些可售卖销售项，再进行匹配
2. **判断逻辑**
   - 每个招标功能点 → 查找销售项清单中是否有能覆盖该功能的**销售项**
   - 有完全覆盖的 → exact（正偏离），匹配列填销售项名称
   - 有部分覆盖的 → partial（部分满足），匹配列填销售项名称，note 说明缺口
   - 完全没有的 → no_match（负偏离），匹配列填「—」，note 说明原因
3. **禁止行为**
   - ❌ 禁止将组件能力（如 `vms`、`aimms`、`els`）当作匹配项填入
   - ❌ 禁止因为产品有某个技术组件就推断能覆盖，必须看是否有对应的**可售卖销售项**
   - ❌ 禁止自行拆分或组合销售项名称，必须使用产品页清单中的正式名称
4. **示例**
   - 正确：「安防监控」→ 匹配销售项「视频监控」✓
   - 正确：「车辆自动识别」→ 匹配销售项「园区卡口」✓
   - 错误：「安防监控」→ 匹配 `Infovision_iSee-VMS` ✗（这是组件 ID，不是销售项）
   - 错误：「门禁管理」→ 匹配 `acs` ✗（这是组件缩写，不是销售项）

### 步骤 3 关键产出：Excel 报告（match-report.xlsx）

**逐条匹配完成后，必须生成一个包含两个 Sheet 的 Excel 文件。** 用 Python openpyxl 生成，脚本写入 `.py` 文件再执行。

#### Sheet 1：功能点匹配报告

即原来的偏离分析 CSV，列如下：

| 列                 | 内容                       | 说明                                 |
| ------------------ | -------------------------- | ------------------------------------ |
| 编号               | T-1, T-2...                | 功能点编号                           |
| 模块               | 模块名称                   | 如「M1 数字集成服务」                |
| 功能点（原始清单） | 从 source.md 逐字复制      | 不得修改                             |
| 匹配销售项         | 销售项正式名称             | no_match 时填「—」                   |
| **匹配证据**       | 销售项详情页中匹配的段落   | **从详情页摘取，关键词红色加粗高亮** |
| 偏离               | exact / partial / no_match | —                                    |
| 满足(ok)           | 已具备的能力               | 多行用换行分隔                       |
| 勉强硬上(hard)     | 需定制/增值的能力          | 多行用换行分隔                       |
| 不满足(no)         | 不具备的能力               | 多行用换行分隔                       |
| 结论说明           | 匹配结论                   | —                                    |
| 证据引用           | 知识库路径:行号            | —                                    |

**匹配证据列**：从销售项详情页「技术规格」或「销售项描述」中摘取与功能点直接相关的段落原文，用 openpyxl Rich Text 对匹配关键词做红色加粗高亮。no_match 时留空。

**样式规则**：

- 表头：蓝底(#D9E1F2)加粗居中
- **no_match 行**：整行红色填充(#FFC7CE)，红色字体(#9C0006)
- **partial 行**：整行黄色填充(#FFEB9C)，深黄字体(#9C6500)
- **exact 行**：正常白色背景
- 功能点列、匹配证据列、结论列：自动换行，列宽 50
- 冻结首行

#### Sheet 2：销售项清单

该产品匹配命中的销售项汇总（去重），按模板 11 列格式。**所有数据必须从销售项详情页的 frontmatter 和正文中直接提取，不得修改、不得推断、不得自行填写。**

| 列       | 来源字段                             | 提取规则                            |
| -------- | ------------------------------------ | ----------------------------------- |
| 序号     | 自增                                 | 从 1 开始                           |
| 名称     | `title`（frontmatter）               | 直接取                              |
| 产品类别 | `product` + `version`（frontmatter） | 拼接                                |
| 型号     | `module_id`（frontmatter）           | 直接取                              |
| 技术规格 | 正文「技术规格」段落                 | **完整复制，一字不改**              |
| 单位     | `unit`（frontmatter）                | 直接取，不推断                      |
| 数量     | 留空                                 | 人工填写                            |
| 单价(元) | `fixed_price`（frontmatter）优先     | 直接取数字；无则从 `price` 取第一档 |
| 合价(元) | 留空                                 | 人工填写                            |
| 备注     | 正文「销售项描述」段落               | **完整复制，一字不改**              |
| 图片     | 留空                                 | —                                   |

**禁止行为**：❌ 把销售项描述填到单价列 ❌ 把单位填到数量列 ❌ 自行总结技术规格 ❌ 修改任何从实体页提取的内容 |

**样式规则**：

- 标题行（第1行）：合并 A1:K1，「配置清单」，14pt 加粗居中
- 表头（第3行）：蓝底(#D9E1F2)加粗居中
- 数据行：自动换行，边框线
- 列宽：序号6/名称20/产品类别30/型号25/技术规格50/单位6/数量8/单价12/合价12/备注50/图片8

**生成脚本模板**：

```python
import sys
sys.stdout.reconfigure(encoding='utf-8')
from openpyxl import Workbook
from openpyxl.styles import Font, Alignment, Border, Side, PatternFill
from openpyxl.utils import get_column_letter

wb = Workbook()

# ====== Sheet 1: 功能点匹配报告 ======
ws1 = wb.active
ws1.title = '功能点匹配报告'

# 表头
headers1 = ['编号', '模块', '功能点（原始清单）', '匹配销售项', '偏离', '满足(ok)', '勉强硬上(hard)', '不满足(no)', '结论说明', '证据引用']
header_font = Font(name='微软雅黑', size=10, bold=True)
header_fill = PatternFill(start_color='D9E1F2', end_color='D9E1F2', fill_type='solid')
red_fill = PatternFill(start_color='FFC7CE', end_color='FFC7CE', fill_type='solid')
yellow_fill = PatternFill(start_color='FFEB9C', end_color='FFEB9C', fill_type='solid')
red_font = Font(name='微软雅黑', size=9, color='9C0006')
yellow_font = Font(name='微软雅黑', size=9, color='9C6500')
normal_font = Font(name='微软雅黑', size=9)
thin_border = Border(left=Side('thin'), right=Side('thin'), top=Side('thin'), bottom=Side('thin'))
wrap_align = Alignment(vertical='top', wrap_text=True)
center_align = Alignment(horizontal='center', vertical='center', wrap_text=True)

for ci, h in enumerate(headers1, 1):
    cell = ws1.cell(row=1, column=ci, value=h)
    cell.font = header_font
    cell.fill = header_fill
    cell.border = thin_border
    cell.alignment = center_align

# 数据行
for ri, item in enumerate(items):
    row = ri + 2
    level = item.get('level', 'partial')
    is_red = level == 'no_match'
    is_yellow = level == 'partial'
    row_fill = red_fill if is_red else (yellow_fill if is_yellow else None)
    row_font = red_font if is_red else (yellow_font if is_yellow else normal_font)

    vals = [item['id'], item['module'], item['summary'], item['sales'], level,
            item.get('ok', ''), item.get('hard', ''), item.get('no', ''), item.get('note', ''), item.get('evidence', '')]
    for ci, v in enumerate(vals, 1):
        cell = ws1.cell(row=row, column=ci, value=v)
        cell.font = row_font
        cell.border = thin_border
        cell.alignment = wrap_align if ci in [3, 6, 7, 8, 9] else center_align
        if row_fill:
            cell.fill = row_fill

# 列宽
widths1 = [8, 18, 50, 20, 10, 30, 30, 30, 40, 35]
for ci, w in enumerate(widths1, 1):
    ws1.column_dimensions[get_column_letter(ci)].width = w
ws1.freeze_panes = 'A2'

# ====== Sheet 2: 销售项清单 ======
ws2 = wb.create_sheet('销售项清单')
ws2.merge_cells('A1:K1')
ws2['A1'] = '配置清单'
ws2['A1'].font = Font(name='微软雅黑', size=14, bold=True)
ws2['A1'].alignment = Alignment(horizontal='center', vertical='center')
ws2.row_dimensions[1].height = 30

headers2 = ['序号', '名称', '产品类别', '型号', '技术规格', '单位', '数量', '单价(元)', '合价(元)', '备注', '图片']
for ci, h in enumerate(headers2, 1):
    cell = ws2.cell(row=3, column=ci, value=h)
    cell.font = header_font
    cell.fill = header_fill
    cell.border = thin_border
    cell.alignment = center_align

for ri, sale in enumerate(sales):
    row = ri + 4
    vals = [ri + 1, sale['name'], sale['product'], sale['module_id'], sale['spec'],
            sale.get('unit', '套'), '', sale.get('price', ''), '', sale.get('description', ''), '']
    for ci, v in enumerate(vals, 1):
        cell = ws2.cell(row=row, column=ci, value=v)
        cell.font = normal_font
        cell.border = thin_border
        cell.alignment = wrap_align if ci in [5, 10] else center_align

widths2 = [6, 20, 30, 25, 50, 6, 8, 12, 12, 50, 8]
for ci, w in enumerate(widths2, 1):
    ws2.column_dimensions[get_column_letter(ci)].width = w
ws2.freeze_panes = 'A4'

wb.save('output/<标的>/match-report.xlsx')
print('done')
```

## 步骤 4：匹配复核（product-matcher Agent，Smith）

**步骤 3 完成后，必须对每条匹配结论逐条复核。** 复核不是重做匹配，而是用严格判断依据审查已有结论，修正误判。

调用 `product-matcher` Agent 执行复核：

- 输入：步骤 3 产出的 `match-report.csv`
- 过程：逐条过五条判断依据（能力方向 → 能力边界 → 规格参数 → 场景适配 → 交付约束）
- 重点排查六种常见误判：方向误判、关键词误判、大体覆盖误判、场景错配、组件误判、依赖遗漏
- 产出：复核报告（统计 + 修正明细），追加到 `match-report.md` 末尾
- 修正后的 CSV 覆盖写入 `output/<标的>/match-report.csv`

## 收尾

- 汇总产出，向用户展示匹配报告要点（总览表 + 风险项）
- 提示人工复核点：`partial` 与 `no_match` 条目
- **调用 `tender_report` 工具**生成详细 HTML 报告（传入标的文件名或目录名）。工具会优先读取 `match-report.csv`
- **确认 `match-report.xlsx` 已生成**：按模板清单 11 列格式，数据从销售项详情页提取（名称/产品类别/型号/技术规格/单位/单价/备注），可直接提交
- 报告路径：`output/<标的>/match-report.md`、`output/<标的>/match-report.csv`、`output/<标的>/match-report.xlsx`、`output/<标的>/match-report.html`

### HTML 报告生成规则（必须遵守）

HTML 报告必须按以下结构生成，参考 `match-report_demo.html` 格式：

#### 报告结构（从上到下）

1. **Header**：标题「评标产品匹配详细报告 · <招标文件名>」+ 元数据（功能模块数、功能点数、主匹配产品、销售项来源）
2. **匹配说明框**（info-box）：说明匹配基于销售项清单，标注销售项来源文件
3. **统计卡片**（stats）：正偏离 / 部分满足 / 负偏离 三列，数字+标签
4. **模块级匹配总览表**（第一个 card）：
   - 列：模块 / 匹配销售项 / 产品/版本 / 模块级别 / 置信度
   - 每行一个模块（按招标文件原始章节顺序）
   - 模块级别用 badge 标注
5. **不满足项汇总**（第二个 card）：
   - 标题「⚠️ 不满足项汇总（高亮，需重点关注）」
   - 每条：`[编号] 模块名 — 章节名` + 功能点名称 + 不满足原因
   - 黄色背景卡片样式
6. **逐功能点详细偏离分析**（第三个 card）：
   - 每个模块一个子卡片（class="card module"）
   - mod-head：模块名 + 匹配销售项 + 产品版本 + 模块级别 + 置信度
   - 表格列：编号 / 功能点（原始清单） / 匹配销售项 / 偏离 / 结论说明 / 满足度细分
   - 不满足行整行红色背景（`row-no`）
   - 满足度细分列：exact →「满足」；partial →「满足/勉强硬上/不满足」三档；no_match →「不满足」

#### 样式规范

- 配色：正偏离 `#1a7f37` / 部分满足 `#9a6700` / 负偏离 `#cf222e`
- 不满足行背景：`#fff0f0`，边框 `#f5c6c6`
- 风险项背景：`#fff8e6`，左边框 `#9a6700`
- 销售项列文字颜色：`#2d6a8f`
- 使用 `match-report_demo.html` 的完整 CSS 样式

#### 数据规范

- 匹配列填**销售项名称**（如「视频监控」「门禁管理」），不填组件 ID
- 无匹配销售项时填「—」
- 产品版本从知识库获取（如「Infovision iPark v2.2.0」）
- 置信度 = exact 数 / 该模块功能点总数
- 模块级别：no > exact 且 no > partial → 负偏离；exact >= partial → 正偏离；否则 → 部分满足
- **功能点（原始清单）列必须与招标文件原文一模一样，不得自行修改、简化、总结、改写**。必须从 `source.md` 中逐字复制原文，保留全部细节（含限定词、并列子项、数字、单位等），不得做任何润色或缩写

#### 生成方式

- 优先使用 `tender_report` 工具生成；若工具解析 JSON 失败，则用 Node.js 脚本手动生成
- 脚本需包含完整的结构化数据（所有模块、功能点、匹配结论），直接输出 HTML 文件
- 脚本过大时写入 `.mjs` 文件再执行，避免命令行长度限制

## 执行纪律

- 链式执行，前一步未完成不得进入下一步
- 任何一步失败：说明失败原因与已完成的产出，不虚构结果
- **原文保真**：解析与抽取阶段不得对原始文本简化、总结、改写；必须按原始参数描述原样拆分，逐字保留全部细节（含"传染病、残疾人"等限定词）；所有行号引用基于 `output/<标的>/source.md`
- **严谨匹配**：匹配时同时判断文本相似度与语义相似度（文本不同但意思相同应视为满足；文本相似但语义不等价不得判满足）；针对原始需求中每一个功能点/细节字样逐一匹配，防止漏细节；产品缺失的能力必须如实标注为不满足/部分满足；search 必须带 `--content` 获取全文
- **证据链完整**：parse-report 元数据→source.md 行号；extraction-report 技术要求→source.md 行号；match-report 匹配结论→知识库路径+行号
- **评分办法不遗漏**：从步骤 2 开始必须抽取评分办法，步骤 3 评估产品是否能满足评分标准
- **全程使用中文思考与输出**：包括内部推理（reasoning）也用中文，不用英文