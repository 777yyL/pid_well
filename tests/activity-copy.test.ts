import { test } from "node:test";
import assert from "node:assert/strict";
import { activityCopy } from "../web/activity-copy.js";
test("上下文压缩显示整理笔记，而不是泛化为等待模型", () => {
  assert.match(
    activityCopy({ phase: "压缩上下文并保存检查点", waitingSeconds: 5 }).title,
    /笔记/,
  );
});

test("阶段提示对应真实动作，长等待不虚构进展", () => {
  const reading = activityCopy({
    tool: "read_document",
    phase: "",
    waitingSeconds: 5,
  });
  assert.match(reading.title, /原文/);
  assert.match(
    activityCopy({ tool: "wiki_read", phase: "", waitingSeconds: 5 }).title,
    /证据/,
  );
  const waiting = activityCopy({
    tool: "wiki_read",
    phase: "",
    waitingSeconds: 90,
  });
  assert.match(waiting.description, /尚未返回/);
  assert.doesNotMatch(waiting.description, /即将|完成|分钟后/);
});
test("异常状态优先于趣味文案，排队不冒充开始工作", () => {
  assert.equal(
    activityCopy({
      tool: "export_report",
      phase: "",
      waitingSeconds: 5,
      disconnected: true,
    }).tone,
    "warning",
  );
  assert.match(
    activityCopy({
      tool: "read_document",
      phase: "",
      waitingSeconds: 5,
      stale: true,
    }).title,
    /更新延迟/,
  );
  assert.match(
    activityCopy({
      tool: "read_document",
      phase: "",
      waitingSeconds: 5,
      queued: true,
    }).description,
    /排队/,
  );
  assert.match(
    activityCopy({ phase: "模型正在生成回复或下一步动作", waitingSeconds: 5 })
      .description,
    /等待模型/,
  );
});
