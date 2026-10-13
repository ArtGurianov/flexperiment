export type CourseCommercialSummary = {
  readonly courseRef: string;
  readonly offerRef: string | null;
  readonly accessModel: "FREE" | "PAID";
  readonly withdrawn: boolean;
  readonly saleMode: "CLOSED" | "ACCEPTANCE_ONLY" | "PUBLIC";
  readonly priceKopecks: number | null;
};
