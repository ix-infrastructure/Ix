import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Verify that goals and truths are semantically separated:
 * - api.ts has separate listGoals/createGoal and listTruth/createTruth methods
 * - goal.ts calls listGoals, not listTruth
 * - truth.ts still calls listTruth
 */

const apiTsPath = path.resolve(__dirname, "../../client/api.ts");
const apiContent = fs.readFileSync(apiTsPath, "utf-8");

const goalTsPath = path.resolve(__dirname, "../commands/goal.ts");
const goalContent = fs.readFileSync(goalTsPath, "utf-8");

const goalsTsPath = path.resolve(__dirname, "../commands/goals.ts");
const goalsContent = fs.readFileSync(goalsTsPath, "utf-8");

const truthTsPath = path.resolve(__dirname, "../commands/truth.ts");
const truthContent = fs.readFileSync(truthTsPath, "utf-8");

const planTsPath = path.resolve(__dirname, "../commands/plan.ts");
const planContent = fs.readFileSync(planTsPath, "utf-8");

describe("api.ts has separate goal and truth methods", () => {
  it("has listGoals method", () => {
    expect(apiContent).toContain("async listGoals()");
  });

  it("has createGoal method", () => {
    expect(apiContent).toContain("async createGoal(");
  });

  it("listGoals calls /v1/truth endpoint (goals are stored as truth)", () => {
    expect(apiContent).toContain('"/v1/truth"');
  });

  it("still has listTruth method", () => {
    expect(apiContent).toContain("async listTruth()");
  });

  it("still has createTruth method", () => {
    expect(apiContent).toContain("async createTruth(");
  });
});

describe("goal.ts uses goal endpoints, not truth", () => {
  it("goal.ts calls listGoals", () => {
    expect(goalContent).toContain("client.listGoals()");
  });

  it("goal.ts calls createGoal", () => {
    expect(goalContent).toContain("client.createGoal(");
  });

  it("goal.ts does NOT call listTruth", () => {
    expect(goalContent).not.toContain("client.listTruth()");
  });

  it("goal.ts does NOT call createTruth", () => {
    expect(goalContent).not.toContain("client.createTruth(");
  });

  it("goal.ts description does not mention truth alias", () => {
    expect(goalContent).not.toContain("aliases for ix truth");
  });
});

describe("goals.ts uses goal endpoints", () => {
  it("goals.ts calls listGoals", () => {
    expect(goalsContent).toContain("client.listGoals()");
  });

  it("goals.ts does NOT call listTruth", () => {
    expect(goalsContent).not.toContain("client.listTruth()");
  });
});

describe("truth.ts still uses truth endpoints", () => {
  it("truth.ts calls listTruth", () => {
    expect(truthContent).toContain("client.listTruth()");
  });

  it("truth.ts calls createTruth", () => {
    expect(truthContent).toContain("client.createTruth(");
  });
});

describe("plan.ts uses goal endpoints for goal resolution", () => {
  it("plan create resolves goals via listGoals", () => {
    expect(planContent).toContain("client.listGoals()");
  });

  it("plan create does NOT use listTruth for goal resolution", () => {
    expect(planContent).not.toContain("client.listTruth()");
  });
});
