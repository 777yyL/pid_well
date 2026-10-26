import test from "node:test";
import assert from "node:assert/strict";
import {
  assessmentStartPrompt,
  guidePhase,
  startAssessmentPrompt,
} from "../web/workflow-guide.js";

test("快速初评先保留原行并等待产品范围，深度评估保留原提示", () => {
  const prompt = assessmentStartPrompt("quick");
  assert.match(prompt, /保留原清单行/);
  assert.match(prompt, /不另行要求用户确认条款/);
  assert.match(prompt, /此阶段不要执行销售项匹配/);
  assert.match(prompt, /用户确认范围并点击继续初评后才开始批量评估/);
  assert.equal(assessmentStartPrompt("agent"), startAssessmentPrompt);
});

test("操作引导按真实项目阶段推进，执行及归档期间不打断", () => {
  const state: Parameters<typeof guidePhase>[0] = {
    documents: [],
    requirements: [],
    assessments: [],
    scopeStatus: "pending",
    complete: false,
    active: false,
    archived: false,
  };
  assert.equal(guidePhase(state), "upload");
  state.documents = [{ status: "parsing" }];
  assert.equal(guidePhase(state), null);
  state.documents = [{ status: "ready" }];
  assert.equal(guidePhase(state), "start");
  state.active = true;
  assert.equal(guidePhase(state), null);
  state.active = false;
  state.requirements = [{ confirmed: false }];
  assert.equal(guidePhase(state), "requirements");
  state.requirements[0].confirmed = true;
  assert.equal(guidePhase(state), "products");
  state.hasRecommendations = true;
  assert.equal(guidePhase(state), "selection");
  state.scopeStatus = "confirmed";
  assert.equal(guidePhase(state), "continue");
  state.assessments = [{ reviewed: false }];
  assert.equal(guidePhase(state), "review");
  state.complete = true;
  assert.equal(guidePhase(state), "export");
  state.archived = true;
  assert.equal(guidePhase(state), null);
});
