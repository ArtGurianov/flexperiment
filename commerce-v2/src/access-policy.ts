export type AccessDecision =
  | "ALLOW"
  | "SIGN_IN_REQUIRED"
  | "CONSENT_REQUIRED"
  | "DENY"
  | "PURCHASE_REQUIRED"
  | "NOT_FOR_SALE"
  /** FLEX-128: a FREE course opens only after the customer's explicit enrollment. */
  | "ENROLLMENT_REQUIRED";

export type LessonAccessInput = {
  readonly customerId?: string;
  readonly courseRef: string;
  readonly lesson?: {
    readonly everPublished: boolean;
    readonly effectiveVisibility: "LISTED" | "UNLISTED";
    readonly freePreview: boolean;
    readonly withdrawn: boolean;
  };
  readonly courseProduct?: {
    readonly accessModel: "FREE" | "PAID";
    readonly withdrawn: boolean;
    readonly saleMode: "CLOSED" | "ACCEPTANCE_ONLY" | "PUBLIC";
  };
  readonly grants: ReadonlyArray<{
    readonly scope: "COURSE" | "ALL_COURSES";
    readonly courseRef?: string;
    readonly revoked: boolean;
  }>;
  readonly activeDenyNonEntitledOverride: boolean;
  readonly projectionStale: boolean;
  readonly retainedFreeEnrollment?: boolean;
};

export function decideLessonAccess(input: LessonAccessInput): AccessDecision {
  if (!input.customerId) return "SIGN_IN_REQUIRED";
  if (!input.lesson || !input.lesson.everPublished) return "DENY";
  if (!input.courseProduct || input.courseProduct.withdrawn || input.lesson.withdrawn) return "DENY";

  const entitled = input.grants.some((grant) => !grant.revoked && (
    grant.scope === "ALL_COURSES" || (grant.scope === "COURSE" && grant.courseRef === input.courseRef)
  ));
  if (entitled) return "ALLOW";
  if (input.projectionStale) return "DENY";
  if (input.lesson.effectiveVisibility === "UNLISTED" || input.activeDenyNonEntitledOverride) return "DENY";
  // An explicit FREE enrollment keeps its course access after FREE→PAID (FLEX-128).
  if (input.retainedFreeEnrollment) return "ALLOW";
  // Previews inside a FREE course also require the enrollment: a grant never enrolls by itself.
  if (input.courseProduct.accessModel === "FREE") return "ENROLLMENT_REQUIRED";
  if (input.lesson.freePreview) return "ALLOW";
  return input.courseProduct.saleMode === "CLOSED" ? "NOT_FOR_SALE" : "PURCHASE_REQUIRED";
}
