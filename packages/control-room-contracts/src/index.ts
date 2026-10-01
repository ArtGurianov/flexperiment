export type AccessModel = "FREE" | "PAID";
export type ProductKind = "ONLINE_COURSE" | "COURSE_BUNDLE" | "LAB";
export type SaleMode = "CLOSED" | "ACCEPTANCE_ONLY" | "PUBLIC";

export type ControlRoomCatalogueCourse = {
  courseRef: string;
  productRef: string;
  accessModel: AccessModel;
  withdrawn: boolean;
  withdrawnReason: string | null;
  withdrawnTermsRef: string | null;
  version: number;
  offer: null | {
    offerRef: string;
    priceKopecks: number;
    saleMode: SaleMode;
    acceptanceAllowlist: string[];
  };
  projection: null | {
    version: number;
    visibility: "LISTED" | "UNLISTED";
    lastReconciledAt: string;
  };
};

export type ProductConfigurationCommand = {
  productRef: string;
  offerRef: string;
  kind: ProductKind;
  accessModel: AccessModel;
  courseRef?: string;
  occurrenceRef?: string;
  priceKopecks: number;
  saleMode: SaleMode;
  acceptanceAllowlist?: string[];
  expectedVersion: number;
};

export type ProductWithdrawalCommand = {
  reason: string;
  termsRef: string;
  expectedVersion: number;
};

export type ControlRoomMerchantPromotion = {
  id: string;
  code: string;
  discountKind: "FIXED" | "PERCENT_BPS";
  discountValue: number;
  eligibleOfferRef: string | null;
  startsAt: string | null;
  endsAt: string | null;
  active: boolean;
  version: number;
  updatedAt: string;
};

export type MerchantPromotionCommand = Omit<ControlRoomMerchantPromotion, "id" | "version" | "updatedAt"> & {
  id?: string;
  expectedVersion: number;
};

export type ControlRoomOrder = {
  orderPublicId: string;
  state: "DRAFT" | "PAYMENT_PENDING" | "FULFILLED" | "EXPIRED" | "CANCELLED" | "REFUND_PENDING" | "REFUNDED" | "REVIEW_REQUIRED";
  customerId: string;
  customerEmail: string;
  productKind: ProductKind;
  productRef: string;
  offerRef: string;
  title: string;
  amountKopecks: number;
  currency: "RUB";
  railState: string;
  refrefAttemptId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ControlRoomCustomer = {
  customerId: string;
  email: string;
  displayName: string | null;
  authBound: boolean;
  orderCount: number;
  activeEntitlementCount: number;
  createdAt: string;
};

export type ControlRoomEntitlement = {
  entitlementId: string;
  customerId: string;
  customerEmail: string;
  scope: "COURSE" | "ALL_COURSES";
  courseRef: string | null;
  sourceOrderPublicId: string;
  sourceKind: "PURCHASE" | "MANUAL";
  grantedAt: string;
  revokedAt: string | null;
  revocationReason: string | null;
};

export type ManualEntitlementGrantCommand = {
  customerId: string;
  scope: "COURSE" | "ALL_COURSES";
  courseRef?: string;
  reason: string;
  evidenceRef: string;
  legalTermsRef: string;
  idempotencyKey: string;
};

export type ManualEntitlementRevocationCommand = {
  reason: string;
  evidenceRef: string;
};

export type ControlRoomCity = {
  cityId: string;
  slug: string;
  title: string;
  occurrenceCount: number;
};

export type ControlRoomLabOccurrence = {
  occurrenceRef: string;
  cityId: string;
  cityTitle: string;
  title: string;
  startsAt: string;
  endsAt: string;
  timezone: string;
  capacity: number;
  salesStatus: SaleMode;
};

export type RefundPolicyFacts = {
  schema: "flexperiment.refund-policy-facts/1";
  productKind: ProductKind;
  productRef: string;
  courseRef: string | null;
  paidLineAmountKopecks: number;
  orderedAt: string;
  courseAccessStartedAt: string | null;
  requestedAt: string;
  automatedEligibility: "NOT_EVALUATED";
};

export type ControlRoomRefundCase = {
  requestPublicId: string;
  orderPublicId: string;
  reasonCode: "CUSTOMER_REQUEST" | "PRODUCT_WITHDRAWN" | "OCCURRENCE_CHANGED" | "OTHER";
  state: "REQUESTED" | "APPROVED" | "REJECTED" | "EXECUTING" | "REFUNDED" | "REVIEW_REQUIRED";
  policyFacts: RefundPolicyFacts;
  requestedAt: string;
  outcome: "APPROVE" | "REJECT" | null;
  amountKopecks: number | null;
  policyBasis: string | null;
  rationale: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  executionState: "READY" | "PROCESSING" | "SUCCEEDED" | "REVIEW_REQUIRED" | null;
  providerExecutionId: string | null;
  supportReference: string | null;
  lastErrorCode: string | null;
};

export type ControlRoomAttentionItem = {
  operationId: string;
  courseRef: string;
  scopeLevel: "COURSE" | "SECTION" | "LESSON";
  scopeRef: string;
  state: "PENDING" | "FINALIZED" | "SUPERSEDED" | "RELEASED_ROLLED_BACK";
  attentionReason: string;
  orphanedAt: string | null;
  createdAt: string;
  deadlineAt: string;
};

export type ControlRoomIntegrationSummary = {
  paymentMode: "disabled" | "mock" | "refref";
  lastAcceptedPayment: null | { orderPublicId: string; observedAt: string; refrefAttemptId: string };
  outstandingCheckoutCount: number;
  processingRefundCount: number;
  attentionOverrideCount: number;
  staleProjectionCount: number;
  playbackAccess24h: {
    allowed: number;
    denied: number;
    rateLimited: number;
    invalidToken: number;
  };
};

export type ControlRoomListResponse<T, K extends string> = { generatedAt: string } & Record<K, T[]>;
export type CatalogueResponse = ControlRoomListResponse<ControlRoomCatalogueCourse, "courses">;
export type OrdersResponse = ControlRoomListResponse<ControlRoomOrder, "orders">;
export type CustomersResponse = ControlRoomListResponse<ControlRoomCustomer, "customers">;
export type EntitlementsResponse = ControlRoomListResponse<ControlRoomEntitlement, "entitlements">;
export type CitiesResponse = ControlRoomListResponse<ControlRoomCity, "cities">;
export type LabOccurrencesResponse = ControlRoomListResponse<ControlRoomLabOccurrence, "occurrences">;
export type RefundCasesResponse = ControlRoomListResponse<ControlRoomRefundCase, "refunds">;
export type AttentionResponse = ControlRoomListResponse<ControlRoomAttentionItem, "items">;
export type MerchantPromotionsResponse = ControlRoomListResponse<ControlRoomMerchantPromotion, "promotions"> & { reservedPrefix: string };

export type ControlRoomAuthEmail = {
  id: string;
  recipient: string;
  state: "PENDING" | "SENT" | "FAILED";
  attemptCount: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ControlRoomCampaign = {
  id: string;
  courseRef: string;
  state: "DRAFT" | "CONFIRMED" | "DISPATCHING" | "COMPLETED" | "FAILED";
  confirmedBy: string | null;
  confirmedAt: string | null;
  recipientCount: number;
  sentCount: number;
  failedCount: number;
  skippedCount: number;
  createdAt: string;
};

export type EmailOperationsResponse = {
  generatedAt: string;
  authEmails: ControlRoomAuthEmail[];
  campaigns: ControlRoomCampaign[];
};

export type ControlRoomIncident = {
  incidentRef: string;
  kind: "ACCESS_OVERRIDE" | "CHECKOUT" | "REFUND" | "AUTH_EMAIL" | "CAMPAIGN";
  severity: "ATTENTION" | "FAILED" | "UNKNOWN";
  subjectRef: string;
  code: string;
  observedAt: string;
};

export type IncidentsResponse = ControlRoomListResponse<ControlRoomIncident, "incidents">;

export type ControlRoomAuditEntry = {
  id: string;
  source: "MERCHANT" | "CONTROL_ROOM";
  actor: string;
  action: string;
  entityType: string;
  entityId: string;
  details: Record<string, unknown>;
  createdAt: string;
};

export type AuditResponse = ControlRoomListResponse<ControlRoomAuditEntry, "entries">;

export type RefundDecisionCommand = {
  outcome: "APPROVE" | "REJECT";
  amountKopecks?: number;
  policyBasis: string;
  rationale: string;
  actor: string;
};
