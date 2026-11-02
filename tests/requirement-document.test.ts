import { test } from "node:test";
import assert from "node:assert/strict";
import { requirementDocumentView } from "../server/requirement-document.js";
import { wordHtmlLines } from "../server/documents.js";

test("去噪视图保留原文行号，排除目录页码与评分资质，保留混合章节中的真实技术需求", () => {
  const lines = [
    "目录",
    "视频监控……12",
    "第 1 页 共 9 页",
    "资格要求",
    "投标人须具有三年营业执照",
    "评分办法",
    "价格分按最低报价计算",
    "支持人脸识别，准确率不低于99%，得3分",
    "技术要求",
    "录像保存不少于90天",
    "1000",
    "[工作表：门禁]",
    "门禁 | 支持跨控制器反潜回",
  ];
  const copy = [...lines];
  const view = requirementDocumentView(lines);
  assert.deepEqual(lines, copy);
  assert.ok(view.excluded.some((e) => e.line === 5));
  assert.ok(view.excluded.some((e) => e.line === 7));
  assert.match(view.text, /L8: 支持人脸识别/);
  assert.match(view.text, /L10: 录像保存不少于90天/);
  assert.match(view.text, /L11: 1000/);
  assert.match(view.text, /L13: 门禁 \| 支持跨控制器反潜回/);
});
test("重复页眉不作为需求，但重复的能力描述不能全局去重", () => {
  const view = requirementDocumentView([
    "[第1页] 某项目技术文件",
    "[第1页] 支持视频预览",
    "[第2页] 某项目技术文件",
    "[第2页] 支持视频预览",
    "[第3页] 某项目技术文件",
  ]);
  assert.equal(
    view.excluded.filter((e) => e.reason === "重复页眉页脚").length,
    3,
  );
  assert.match(view.text, /L2: .*支持视频预览/);
  assert.match(view.text, /L4: .*支持视频预览/);
  const specs = requirementDocumentView([
    "[第1页] 128 路",
    "[第2页] 128 路",
    "[第3页] 128 路",
  ]);
  assert.equal(specs.excluded.length, 0);
});
test("Word表格保持单元格与行关系，保留标题和数值，解码HTML转义", () => {
  assert.deepEqual(
    wordHtmlLines(
      "<table><tr><td>温度 &lt; 30 且 &gt; -10<br/>延时 &lt;= 300ms</td></tr></table>",
    ),
    ["温度 < 30 且 > -10；延时 <= 300ms"],
  );
  assert.deepEqual(
    wordHtmlLines(
      "<h2>技术要求</h2><table><tr><td><p>功能</p></td><td><p>参数</p></td></tr><tr><td><p>门禁</p></td><td><p>支持反潜回</p><p>数量 &gt;= 128</p></td></tr></table><p>支持 A &amp; B</p>",
    ),
    ["技术要求", "功能 | 参数", "门禁 | 支持反潜回；数量 >= 128", "支持 A & B"],
  );
});
