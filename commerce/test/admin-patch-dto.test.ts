import { describe, expect, it } from "vitest";
import { agentPatchSchema, promoPatchSchema } from "../src/types";

describe("admin PATCH DTO boundaries", () => {
  it("rejects persisted agent fields that must never be accepted from a patch request", () => {
    expect(agentPatchSchema.parse({ display_name: "Updated agent" })).toEqual({ display_name: "Updated agent" });
    expect(agentPatchSchema.safeParse({ display_name: "Updated agent", created_at: "2026-08-28T00:00:00.000Z" }).success).toBe(false);
    expect(agentPatchSchema.safeParse({ default_reward_value: 500, slug: "immutable-slug" }).success).toBe(false);
  });

  it("preserves valid partial promo boundaries without accepting immutable or stored fields", () => {
    expect(promoPatchSchema.parse({ discount_type: "NONE" })).toEqual({ discount_type: "NONE" });
    expect(promoPatchSchema.safeParse({ code: "IMMUTABLE" }).success).toBe(false);
    expect(promoPatchSchema.safeParse({ normalized_code: "IMMUTABLE" }).success).toBe(false);
  });
});
