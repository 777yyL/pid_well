import { test } from "node:test";
import assert from "node:assert/strict";
import { overviewProduct } from "../server/product-overview.js";
const overview = `## iSecure Center
产品档案 isecure-center。
产品标识 iSecure Center · 产品名称 综合安防管理平台 · 产品类目 综合安防软件 / 综合安防管理平台 · 所属部门 软件产品研发中心/通用软件产品部/综合安防产品部 · 维护人 左志红 产品描述 综合安防管理平台，简称iSC。
## 另一个产品
产品标识 Other · 产品名称 其他平台 · 所属部门 其他部门 · 维护人 其他人`;
test("解析真实总览字段，标识与展示名称分离，兼容档案路径", () => {
  const data = overviewProduct(overview, {
    name: "iSecure Center",
    path: "wiki/products/isecure-center.md",
  });
  assert.equal(data?.productName, "综合安防管理平台");
  assert.equal(data?.productLine, "综合安防软件 / 综合安防管理平台");
  assert.equal(
    data?.department,
    "软件产品研发中心/通用软件产品部/综合安防产品部",
  );
  assert.equal(data?.owner, "左志红");
  assert.equal(
    overviewProduct(overview, { name: "未找到", path: "" }),
    undefined,
  );
});
