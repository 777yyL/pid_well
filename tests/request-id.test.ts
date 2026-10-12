import { test } from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { createRequestId } from "../web/request-id.js";
test("局域网 HTTP 没有 randomUUID 时仍生成有效的幂等请求 ID", () => {
  const cryptoWithoutUUID = {
    getRandomValues: webcrypto.getRandomValues.bind(webcrypto),
  } as Crypto;
  const values = new Set(
    Array.from({ length: 100 }, () => createRequestId(cryptoWithoutUUID)),
  );
  assert.equal(values.size, 100);
  for (const value of values)
    assert.match(
      value,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  assert.throws(() => createRequestId({} as Crypto), /浏览器不支持/);
});
