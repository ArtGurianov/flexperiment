import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(resolve(process.cwd(), ".github/workflows/test.yml"), "utf8");

describe("Test workflow trigger contract", () => {
  it("runs the full suite for pull requests, main integration, and explicit manual dispatch only", () => {
    expect(workflow).toMatch(/^\s*pull_request:\s*$/m);
    expect(workflow).toMatch(/^\s*push:\s*\n\s*branches:\s*\n\s*- main\s*$/m);
    expect(workflow).toMatch(/^\s*workflow_dispatch:\s*\{\}\s*$/m);
  });

  it("does not run Test on durable runtime refs", () => {
    const triggers = workflow.match(/^on:\n([\s\S]*?)^concurrency:/m)?.[1] ?? "";
    expect(triggers).toBe("  pull_request:\n  push:\n    branches:\n      - main\n  workflow_dispatch: {}\n\n");
  });
});
