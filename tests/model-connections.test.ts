import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { openDatabase, migrate } from "../server/db.js";
import {
  loadSettings,
  saveAgentSettings,
  settingsView,
} from "../server/settings.js";

test("账户多模型连接：迁移旧配置、独立密钥、切换启用、隔离和删除", async () => {
  const db = await openDatabase("", "memory://");
  try {
    await migrate(db);
    const a = randomUUID(),
      b = randomUUID();
    for (const [id, name] of [
      [a, "a"],
      [b, "b"],
    ])
      await db.query(
        "INSERT INTO users(id,username,display_name,password_hash,role) VALUES($1,$2,$2,'unused','member')",
        [id, name],
      );
    await saveAgentSettings(db, a, {
      model: "custom-model-a",
      modelApiKey: "secret-a",
      modelBaseUrl: "https://a.example/v1",
    });
    await saveAgentSettings(db, a, {
      profileId: "second",
      profileName: "内网模型",
      model: "custom-model-b",
      modelApiKey: "secret-b",
      modelBaseUrl: "http://localhost:12345/v1",
    });
    assert.equal((await loadSettings(db, a)).model, "custom-model-b");
    await saveAgentSettings(db, a, {
      models: ["custom-model-b", "reasoning-model"],
    });
    await saveAgentSettings(db, a, { model: "reasoning-model" });
    assert.equal((await loadSettings(db, a)).model, "reasoning-model");
    assert.equal((await loadSettings(db, a)).modelApiKey, "secret-b");
    assert.equal(
      (await loadSettings(db, a)).modelBaseUrl,
      "http://localhost:12345/v1",
    );
    assert.deepEqual(
      (await settingsView(db, a)).profiles.find((p) => p.id === "second")
        ?.models,
      ["custom-model-b", "reasoning-model"],
    );
    await assert.rejects(
      saveAgentSettings(db, a, { models: ["custom-model-b"] }),
      /当前模型/,
    );
    assert.equal((await loadSettings(db, a)).model, "reasoning-model");
    await saveAgentSettings(db, a, { activeProfileId: "default" });
    assert.equal((await loadSettings(db, a)).modelApiKey, "secret-a");
    await saveAgentSettings(db, a, { activeProfileId: "second" });
    assert.equal((await loadSettings(db, a)).modelApiKey, "secret-b");
    await saveAgentSettings(db, a, { model: "arbitrary-new-model" });
    assert.equal((await loadSettings(db, a)).modelApiKey, "secret-b");
    const view = await settingsView(db, a);
    assert.equal(view.profiles.length, 2);
    assert.ok(!JSON.stringify(view).includes("secret-"));
    assert.equal((await loadSettings(db, b)).model, "");
    await assert.rejects(
      saveAgentSettings(db, b, { activeProfileId: "second" }),
      /不存在/,
    );
    const [stored] = await db.query<{ value: unknown }>(
      "SELECT value FROM user_agent_settings WHERE user_id=$1",
      [a],
    );
    assert.ok(!JSON.stringify(stored).includes("secret-"));
    await saveAgentSettings(db, a, { removeProfileId: "second" });
    assert.equal((await loadSettings(db, a)).model, "custom-model-a");
    await assert.rejects(
      saveAgentSettings(db, a, { removeProfileId: "default" }),
      /至少保留/,
    );
  } finally {
    await db.close();
  }
});
