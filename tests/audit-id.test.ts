import { test } from "node:test";
import assert from "node:assert/strict";
import { audit, type Database } from "../server/db.js";

function databaseReturning(id: unknown): Database {
  return {
    async query<T>() { return [{ id }] as T[]; },
    async transaction(fn) { return fn(this); },
    async close() {},
  };
}

test("审计 ID 统一转换 PostgreSQL bigint 字符串与本地数字返回值", async () => {
  for (const id of [42, "42"]) {
    assert.equal(await audit(databaseReturning(id), null, null, null, "test", {}), 42);
  }
});

test("审计 ID 拒绝精度丢失、空值与无效编号", async () => {
  for (const id of ["9007199254740993", null, "", "abc", 0, -1, 1.5]) {
    await assert.rejects(() => audit(databaseReturning(id), null, null, null, "test", {}));
  }
});
