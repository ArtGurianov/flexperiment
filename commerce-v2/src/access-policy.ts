export type AccessDecision =
  | "ALLOW"
  | "SIGN_IN_REQUIRED"
  | "DENY"
  | "PURCHASE_REQUIRED"
  | "NOT_FOR_SALE";

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
  if (input.courseProduct.accessModel === "FREE") return "ALLOW";
  if (input.lesson.freePreview) return "ALLOW";
  return input.courseProduct.saleMode === "CLOSED" ? "NOT_FOR_SALE" : "PURCHASE_REQUIRED";
}
