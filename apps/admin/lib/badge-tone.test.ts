import { describe, expect, it } from "vitest";
import { badgeTone } from "./badge-tone";

describe("badge tones", () => {
  it("highlights active and completed authoritative states", () => {
    for (const status of ["PUBLISHED", "OPEN", "PAID", "REFUNDED", "SUCCEEDED", "DELIVERED", "CONFIRMED"]) expect(badgeTone(status)).toBe("good");
  });

  it("highlights non-public, closed, and exceptional states", () => {
    for (const status of ["HIDDEN", "CLOSED", "PAUSED", "CANCELLED", "BOUNCED", "CREATE_UNKNOWN", "REVIEW_REQUIRED"]) expect(badgeTone(status)).toBe("warn");
  });

  it("leaves known in-flight states neutral", () => {
    for (const status of ["PENDING", "RECONCILING", "CREATING", "CREATED", "SENDING", "SCHEDULED"]) expect(badgeTone(status)).toBe("neutral");
  });
});
