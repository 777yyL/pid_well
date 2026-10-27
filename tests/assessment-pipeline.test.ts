import { test } from "node:test";
import assert from "node:assert/strict";
import { runEvidencePipeline } from "../server/assessment-pipeline.js";

test("首批判断不等待全部检索，判断期间检索继续且队列有界", async () => {
  let release!: () => void;
  const held = new Promise<void>((r) => {
    release = r;
  });
  let prepared = 0,
    firstPrepared = 0;
  const batches: number[][] = [];
  const operation = runEvidencePipeline(
    Array.from({ length: 30 }, (_, i) => i),
    new AbortController().signal,
    async (i) => {
      prepared++;
      return i;
    },
    async (batch) => {
      batches.push(batch);
      if (batches.length === 1) {
        firstPrepared = prepared;
        await held;
      }
    },
  );
  while (!batches.length) await new Promise((r) => setImmediate(r));
  assert.ok(firstPrepared < 30, "首批不能等待全部输入");
  await new Promise((r) => setImmediate(r));
  assert.ok(prepared > firstPrepared, "判断期间应继续准备下一批");
  assert.ok(prepared <= 17, "最多当前5条+队列10条+两条在途");
  release();
  await operation;
  assert.deepEqual(
    batches.flat().sort((a, b) => a - b),
    Array.from({ length: 30 }, (_, i) => i),
  );
  assert.ok(batches.every((b) => b.length <= 5));
});

test("消费异常停止准备任务，取消不会挂在队列等待", async () => {
  await assert.rejects(
    runEvidencePipeline(
      [1, 2, 3, 4, 5, 6],
      new AbortController().signal,
      async (i) => i,
      async () => {
        throw new Error("scope changed");
      },
    ),
    /scope changed/,
  );
  const controller = new AbortController();
  const run = runEvidencePipeline(
    Array.from({ length: 50 }, (_, i) => i),
    controller.signal,
    async (i, signal) => {
      signal.throwIfAborted();
      return i;
    },
    async () => {
      controller.abort();
    },
  );
  await assert.rejects(run);
});
