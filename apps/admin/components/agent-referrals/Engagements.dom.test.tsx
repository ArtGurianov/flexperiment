import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestQueryClient, QueryClientWrapper } from "../../lib/test-query-client";
import { Engagements } from "./Engagements";

function EngagementsHarness({ focusDistributionId, focusReporting }: { focusDistributionId?: string | null; focusReporting?: boolean } = {}) {
  const [selected, setSelected] = useState<string | null>("e1");
  return <Engagements selected={selected} onSelect={setSelected} focusDistributionId={focusDistributionId} focusReporting={focusReporting} />;
}

const distributionRow = (removalState: string | null) => ({
  distribution_id: "d1",
  current_revision: { revision: 1, channel_key: "telegram", channel_policy_status: "ALLOWED", resource_kind: "channel", resource_identifier: "x", distribution_resource_url: "https://t.me/x/1", published_at: "2026-01-01T00:00:00.000Z", ended_at: null, reported_by: "PARTNER", correction_reason: null, evidence_ref: "ev", created_at: "now" },
  compliance_state: "MARKED_REPORTABLE",
  removal_state: removalState,
  reporting_periods: [],
});

describe("Engagements (Agent Referrals admin console): distribution removal verification", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; vi.restoreAllMocks(); });

  it("requires the operator to enter an actual evidence reference before REMOVAL_CONFIRMED - never a fabricated placeholder", async () => {
    let removalState: string | null = "REMOVAL_CLAIMED";
    const confirmCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
    global.fetch = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/agent-referrals/engagements/e1")) {
        return {
          ok: true, status: 200, json: async () => ({
            engagement: { id: "e1", lifecycle_state: "ACTIVE", created_at: "now" },
            latest_revision: null, creative: null, distributions: [distributionRow(removalState)],
            reward_registry: null, effective_reward_snapshot: null, settlement: null,
            act: null, act_acceptance: null, act_dispute: null, payment_attempts: [],
          }),
        } as Response;
      }
      if (url.includes("/agent-referrals/distributions/d1/confirm-removal")) {
        confirmCalls.push({ url, body: JSON.parse(String(init?.body)) });
        removalState = "REMOVAL_CONFIRMED";
        return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
      }
      throw new Error(`unhandled fetch: ${url}`);
    });
    const user = userEvent.setup();
    const client = createTestQueryClient();
    render(<EngagementsHarness />, { wrapper: (props) => <QueryClientWrapper client={client}>{props.children}</QueryClientWrapper> });

    const evidenceInput = await screen.findByPlaceholderText("Ссылка на подтверждение снятия");
    // No submission is possible without the operator actually typing something -
    // required:true on the field, proven by attempting a click first.
    const confirmButton = screen.getByRole("button", { name: "Подтвердить снятие" });
    await user.click(confirmButton);
    expect(confirmCalls).toHaveLength(0);

    await user.type(evidenceInput, "https://t.me/x/1/2 — screenshot reviewed 2026-09-05");
    await user.click(confirmButton);
    await waitFor(() => expect(confirmCalls).toHaveLength(1));
    expect(confirmCalls[0].body).toEqual({ evidence_ref: "https://t.me/x/1/2 — screenshot reviewed 2026-09-05" });
  });

  it("never offers 'confirm removal' for a distribution with no removal event yet - only 'require removal'", async () => {
    global.fetch = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/agent-referrals/engagements/e1")) {
        return {
          ok: true, status: 200, json: async () => ({
            engagement: { id: "e1", lifecycle_state: "ACTIVE", created_at: "now" },
            latest_revision: null, creative: null, distributions: [distributionRow(null)],
            reward_registry: null, effective_reward_snapshot: null, settlement: null,
            act: null, act_acceptance: null, act_dispute: null, payment_attempts: [],
          }),
        } as Response;
      }
      throw new Error(`unhandled fetch: ${url}`);
    });
    const client = createTestQueryClient();
    render(<EngagementsHarness />, { wrapper: (props) => <QueryClientWrapper client={client}>{props.children}</QueryClientWrapper> });

    await screen.findByRole("button", { name: "Требовать снятия" });
    expect(screen.queryByRole("button", { name: "Подтвердить снятие" })).not.toBeInTheDocument();
  });

  it("distribution fact intake and correction: reporting a new distribution posts the exact partner-facing fields, and correcting an existing one requires a correction reason", async () => {
    const reportCalls: Array<{ body: Record<string, unknown> }> = [];
    const correctCalls: Array<{ body: Record<string, unknown> }> = [];
    global.fetch = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/agent-referrals/engagements/e1")) {
        return {
          ok: true, status: 200, json: async () => ({
            engagement: { id: "e1", lifecycle_state: "ACTIVE", created_at: "now" },
            latest_revision: null, creative: null, distributions: [distributionRow(null)],
            reward_registry: null, effective_reward_snapshot: null, settlement: null,
            act: null, act_acceptance: null, act_dispute: null, payment_attempts: [],
          }),
        } as Response;
      }
      if (url.endsWith("/agent-referrals/engagements/e1/distributions") && init?.method === "POST") {
        reportCalls.push({ body: JSON.parse(String(init.body)) });
        return { ok: true, status: 201, json: async () => ({ distribution_id: "d2" }) } as Response;
      }
      if (url.endsWith("/agent-referrals/distributions/d1/correct") && init?.method === "POST") {
        correctCalls.push({ body: JSON.parse(String(init.body)) });
        return { ok: true, status: 200, json: async () => ({}) } as Response;
      }
      throw new Error(`unhandled fetch: ${url}`);
    });
    const user = userEvent.setup();
    const client = createTestQueryClient();
    render(<EngagementsHarness />, { wrapper: (props) => <QueryClientWrapper client={client}>{props.children}</QueryClientWrapper> });

    await user.type(await screen.findByLabelText("Идентификатор ресурса"), "new-channel-post");
    await user.type(screen.getByLabelText("Ссылка на публикацию"), "https://t.me/x/9");
    await user.type(screen.getByLabelText("Дата публикации"), "2026-09-01T10:00");
    await user.type(screen.getByLabelText("Ссылка на подтверждение"), "ev-new");
    // "Канал" appears in both the report form and (once opened) the correction form - target the report form's own field explicitly.
    await user.type(screen.getAllByLabelText("Канал")[0], "telegram");
    await user.click(screen.getByRole("button", { name: "Отправить" }));
    await waitFor(() => expect(reportCalls).toHaveLength(1));
    expect(reportCalls[0].body).toMatchObject({ channel_key: "telegram", resource_identifier: "new-channel-post", distribution_resource_url: "https://t.me/x/9", evidence_ref: "ev-new" });
    expect(reportCalls[0].body).not.toHaveProperty("correction_reason");

    await user.click(screen.getByRole("button", { name: "Скорректировать" }));
    const correctionForm = (await screen.findByText("Скорректировать факт размещения")).closest("form")!;
    await user.type(within(correctionForm).getByLabelText("Ссылка на подтверждение"), "ev-correction");
    await user.type(within(correctionForm).getByLabelText("Причина коррекции"), "wrong URL");
    await user.click(within(correctionForm).getByRole("button", { name: "Отправить" }));
    await waitFor(() => expect(correctCalls).toHaveLength(1));
    expect(correctCalls[0].body).toMatchObject({ correction_reason: "wrong URL", evidence_ref: "ev-correction" });
  });

  it("round-3 fix: the distribution's ORD reporting tail is readable and actionable from the engagement screen - filing a new period report and recording an ERIR reconciliation both post the exact backend field shapes", async () => {
    const existingPeriod = { reporting_period_key: "2026-08", reporting_basis: "CALENDAR_MONTH", revision: 1, statistics_state: "ACTUAL", submission_state: "NOT_SUBMITTED" };
    const reportCalls: Array<{ body: Record<string, unknown> }> = [];
    const reconciliationCalls: Array<{ body: Record<string, unknown> }> = [];
    global.fetch = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/agent-referrals/engagements/e1")) {
        return {
          ok: true, status: 200, json: async () => ({
            engagement: { id: "e1", lifecycle_state: "ACTIVE", created_at: "now" },
            latest_revision: null, creative: null,
            distributions: [{ ...distributionRow(null), reporting_periods: [existingPeriod] }],
            reward_registry: null, effective_reward_snapshot: null, settlement: null,
            act: null, act_acceptance: null, act_dispute: null, payment_attempts: [],
          }),
        } as Response;
      }
      if (url.endsWith("/agent-referrals/distributions/d1/reports") && init?.method === "POST") {
        reportCalls.push({ body: JSON.parse(String(init.body)) });
        return { ok: true, status: 201, json: async () => ({ id: "r2" }) } as Response;
      }
      if (url.endsWith("/agent-referrals/distributions/d1/reports/2026-09/reconciliation") && init?.method === "POST") {
        reconciliationCalls.push({ body: JSON.parse(String(init.body)) });
        return { ok: true, status: 200, json: async () => ({ id: "r2" }) } as Response;
      }
      throw new Error(`unhandled fetch: ${url}`);
    });
    const user = userEvent.setup();
    const client = createTestQueryClient();
    render(<EngagementsHarness />, { wrapper: (props) => <QueryClientWrapper client={client}>{props.children}</QueryClientWrapper> });

    await user.click(await screen.findByRole("button", { name: "Отчётность" }));
    await screen.findByText("2026-08");
    expect(screen.getByText("ACTUAL")).toBeInTheDocument();
    expect(screen.getByText("NOT_SUBMITTED")).toBeInTheDocument();

    const filingForm = (await screen.findByText("Подать отчёт за период")).closest("form") as HTMLElement;
    await user.type(within(filingForm).getByLabelText("Период (например 2026-09)"), "2026-09");
    await user.type(within(filingForm).getByLabelText("Данные (JSON)"), '{{"views": 1000}');
    await user.type(within(filingForm).getByLabelText("Ссылка на подтверждение"), "ord-report-evidence");
    await user.click(within(filingForm).getByRole("button", { name: "Подать отчёт" }));
    await waitFor(() => expect(reportCalls).toHaveLength(1));
    expect(reportCalls[0].body).toEqual({
      reporting_period_key: "2026-09",
      statistics: { statistics_state: "ACTUAL", statistics_json: { views: 1000 } },
      evidence_ref: "ord-report-evidence",
      correction_reason: undefined,
    });

    const reconciliationForm = (await screen.findByText("Сверка ЕРИР по периоду")).closest("form") as HTMLElement;
    await user.type(within(reconciliationForm).getByLabelText("Период"), "2026-09");
    await user.type(within(reconciliationForm).getByLabelText("Внешний ID операции VK"), "vk-op-1");
    await user.type(within(reconciliationForm).getByLabelText("Код ЕРИР"), "erir-1");
    await user.type(within(reconciliationForm).getByLabelText("Ссылка на подтверждение отправки"), "submission-evidence");
    await user.click(within(reconciliationForm).getByRole("button", { name: "Зафиксировать сверку" }));
    await waitFor(() => expect(reconciliationCalls).toHaveLength(1));
    expect(reconciliationCalls[0].body).toEqual({
      vk_operation_external_id: "vk-op-1", erir_code: "erir-1", submission_evidence_ref: "submission-evidence",
    });
  });

  it.each([
    { reportingBasis: "CALENDAR_MONTH" as const, reason: "ZERO_REWARD_STATISTICS" as const, expectSpecialPeriod: undefined },
    { reportingBasis: "CALENDAR_MONTH" as const, reason: "CONTINUING_STATISTICS" as const, expectSpecialPeriod: undefined },
    { reportingBasis: "PROVIDER_SPECIAL_PERIOD" as const, reason: "ZERO_REWARD_STATISTICS" as const, expectSpecialPeriod: true },
    { reportingBasis: "PROVIDER_SPECIAL_PERIOD" as const, reason: "CONTINUING_STATISTICS" as const, expectSpecialPeriod: false },
  ])(
    "round-4 fix: filing a $reason report on $reportingBasis sends the exact statistics_reason/special_period_is_service_period shape the domain requires (never omitted for non-ORDINARY PROVIDER_SPECIAL_PERIOD, never sent for CALENDAR_MONTH)",
    async ({ reportingBasis, reason, expectSpecialPeriod }) => {
      const reportCalls: Array<{ body: Record<string, unknown> }> = [];
      global.fetch = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/agent-referrals/engagements/e1")) {
          return {
            ok: true, status: 200, json: async () => ({
              engagement: { id: "e1", lifecycle_state: "ACTIVE", created_at: "now" },
              latest_revision: null, creative: null,
              distributions: [{ ...distributionRow(null), reporting_periods: [{ reporting_period_key: "2026-08", reporting_basis: reportingBasis, revision: 1, statistics_state: "ACTUAL", submission_state: "NOT_SUBMITTED" }] }],
              reward_registry: null, effective_reward_snapshot: null, settlement: null,
              act: null, act_acceptance: null, act_dispute: null, payment_attempts: [],
            }),
          } as Response;
        }
        if (url.endsWith("/agent-referrals/distributions/d1/reports") && init?.method === "POST") {
          reportCalls.push({ body: JSON.parse(String(init.body)) });
          return { ok: true, status: 201, json: async () => ({ id: "r2" }) } as Response;
        }
        throw new Error(`unhandled fetch: ${url}`);
      });
      const user = userEvent.setup();
      const client = createTestQueryClient();
      render(<EngagementsHarness />, { wrapper: (props) => <QueryClientWrapper client={client}>{props.children}</QueryClientWrapper> });

      await user.click(await screen.findByRole("button", { name: "Отчётность" }));
      const filingForm = (await screen.findByText("Подать отчёт за период")).closest("form") as HTMLElement;
      // The panel derives its default "Основание периода" from the distribution's own existing reports
      // (all seeded here on the same PROVIDER_SPECIAL_PERIOD/CALENDAR_MONTH basis), so it never needs to
      // be changed by hand for this test.
      await user.type(within(filingForm).getByLabelText("Период (например 2026-09)"), "2026-09");
      await user.type(within(filingForm).getByLabelText("Данные (JSON)"), "{{}");
      await user.selectOptions(within(filingForm).getByLabelText("Причина статистики"), reason);
      await user.type(within(filingForm).getByLabelText("Ссылка на подтверждение"), "ord-report-evidence");
      await user.click(within(filingForm).getByRole("button", { name: "Подать отчёт" }));
      await waitFor(() => expect(reportCalls).toHaveLength(1));
      expect(reportCalls[0].body).toMatchObject({
        reporting_period_key: "2026-09", statistics_reason: reason, evidence_ref: "ord-report-evidence",
      });
      expect(reportCalls[0].body.special_period_is_service_period).toBe(expectSpecialPeriod);
    },
  );

  it("round-4 fix: filing an ORDINARY report never sends statistics_reason or special_period_is_service_period, even on a PROVIDER_SPECIAL_PERIOD distribution", async () => {
    const reportCalls: Array<{ body: Record<string, unknown> }> = [];
    global.fetch = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/agent-referrals/engagements/e1")) {
        return {
          ok: true, status: 200, json: async () => ({
            engagement: { id: "e1", lifecycle_state: "ACTIVE", created_at: "now" },
            latest_revision: null, creative: null,
            distributions: [{ ...distributionRow(null), reporting_periods: [{ reporting_period_key: "2026-08", reporting_basis: "PROVIDER_SPECIAL_PERIOD", revision: 1, statistics_state: "ACTUAL", submission_state: "NOT_SUBMITTED" }] }],
            reward_registry: null, effective_reward_snapshot: null, settlement: null,
            act: null, act_acceptance: null, act_dispute: null, payment_attempts: [],
          }),
        } as Response;
      }
      if (url.endsWith("/agent-referrals/distributions/d1/reports") && init?.method === "POST") {
        reportCalls.push({ body: JSON.parse(String(init.body)) });
        return { ok: true, status: 201, json: async () => ({ id: "r2" }) } as Response;
      }
      throw new Error(`unhandled fetch: ${url}`);
    });
    const user = userEvent.setup();
    const client = createTestQueryClient();
    render(<EngagementsHarness />, { wrapper: (props) => <QueryClientWrapper client={client}>{props.children}</QueryClientWrapper> });

    await user.click(await screen.findByRole("button", { name: "Отчётность" }));
    const filingForm = (await screen.findByText("Подать отчёт за период")).closest("form") as HTMLElement;
    expect(within(filingForm).queryByLabelText("Основание периода")).not.toBeInTheDocument();
    await user.type(within(filingForm).getByLabelText("Период (например 2026-09)"), "2026-09");
    await user.type(within(filingForm).getByLabelText("Данные (JSON)"), "{{}");
    await user.type(within(filingForm).getByLabelText("Ссылка на подтверждение"), "ord-report-evidence");
    await user.click(within(filingForm).getByRole("button", { name: "Подать отчёт" }));
    await waitFor(() => expect(reportCalls).toHaveLength(1));
    expect(reportCalls[0].body).not.toHaveProperty("statistics_reason");
    expect(reportCalls[0].body).not.toHaveProperty("special_period_is_service_period");
  });

  it("round-4 fix: an invalid statistics JSON payload surfaces a validation message instead of throwing, and does not submit", async () => {
    const reportCalls: Array<{ body: Record<string, unknown> }> = [];
    global.fetch = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/agent-referrals/engagements/e1")) {
        return {
          ok: true, status: 200, json: async () => ({
            engagement: { id: "e1", lifecycle_state: "ACTIVE", created_at: "now" },
            latest_revision: null, creative: null, distributions: [distributionRow(null)],
            reward_registry: null, effective_reward_snapshot: null, settlement: null,
            act: null, act_acceptance: null, act_dispute: null, payment_attempts: [],
          }),
        } as Response;
      }
      if (url.endsWith("/agent-referrals/distributions/d1/reports") && init?.method === "POST") {
        reportCalls.push({ body: JSON.parse(String(init.body)) });
        return { ok: true, status: 201, json: async () => ({ id: "r2" }) } as Response;
      }
      throw new Error(`unhandled fetch: ${url}`);
    });
    const user = userEvent.setup();
    const client = createTestQueryClient();
    render(<EngagementsHarness />, { wrapper: (props) => <QueryClientWrapper client={client}>{props.children}</QueryClientWrapper> });

    await user.click(await screen.findByRole("button", { name: "Отчётность" }));
    const filingForm = (await screen.findByText("Подать отчёт за период")).closest("form") as HTMLElement;
    await user.type(within(filingForm).getByLabelText("Период (например 2026-09)"), "2026-09");
    await user.type(within(filingForm).getByLabelText("Данные (JSON)"), "not json");
    await user.type(within(filingForm).getByLabelText("Ссылка на подтверждение"), "ord-report-evidence");
    await user.click(within(filingForm).getByRole("button", { name: "Подать отчёт" }));
    await screen.findByText("Некорректный JSON");
    expect(reportCalls).toHaveLength(0);
  });

  it("round-4 fix: a distribution's own review-queue focus highlights exactly that row (data-focused) among several distributions on the same engagement, not just the engagement itself", async () => {
    global.fetch = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/agent-referrals/engagements/e1")) {
        return {
          ok: true, status: 200, json: async () => ({
            engagement: { id: "e1", lifecycle_state: "ACTIVE", created_at: "now" },
            latest_revision: null, creative: null,
            distributions: [
              { ...distributionRow(null), distribution_id: "d1" },
              { ...distributionRow("OVERDUE_REMOVAL"), distribution_id: "d2" },
            ],
            reward_registry: null, effective_reward_snapshot: null, settlement: null,
            act: null, act_acceptance: null, act_dispute: null, payment_attempts: [],
          }),
        } as Response;
      }
      throw new Error(`unhandled fetch: ${url}`);
    });
    const client = createTestQueryClient();
    render(<EngagementsHarness focusDistributionId="d2" focusReporting={false} />, { wrapper: (props) => <QueryClientWrapper client={client}>{props.children}</QueryClientWrapper> });

    // d2 (OVERDUE_REMOVAL) is the only row with a confirm-removal form; d1 (no removal event) is not.
    const d2Row = (await screen.findByPlaceholderText("Ссылка на подтверждение снятия")).closest("tr") as HTMLElement;
    expect(d2Row.getAttribute("data-focused")).toBe("true");
    expect(d2Row.className).toContain("row-expanded");

    const focusedRows = document.querySelectorAll('tr[data-focused="true"]');
    expect(focusedRows).toHaveLength(1);
    expect(focusedRows[0]).toBe(d2Row);

    const allRows = screen.getAllByRole("row");
    const d1Row = allRows.find((row) => row !== d2Row && row.querySelector("td"));
    expect(d1Row?.getAttribute("data-focused")).not.toBe("true");
  });

  it("round-4 fix: focusReporting auto-opens the exact focused distribution's reporting panel, not another distribution's", async () => {
    global.fetch = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/agent-referrals/engagements/e1")) {
        return {
          ok: true, status: 200, json: async () => ({
            engagement: { id: "e1", lifecycle_state: "ACTIVE", created_at: "now" },
            latest_revision: null, creative: null,
            distributions: [
              { ...distributionRow(null), distribution_id: "d1", reporting_periods: [{ reporting_period_key: "2026-01", reporting_basis: "CALENDAR_MONTH", revision: 1, statistics_state: "ACTUAL", submission_state: "NOT_SUBMITTED" }] },
              { ...distributionRow(null), distribution_id: "d2", reporting_periods: [{ reporting_period_key: "2026-07", reporting_basis: "CALENDAR_MONTH", revision: 1, statistics_state: "ACTUAL", submission_state: "NOT_SUBMITTED" }] },
            ],
            reward_registry: null, effective_reward_snapshot: null, settlement: null,
            act: null, act_acceptance: null, act_dispute: null, payment_attempts: [],
          }),
        } as Response;
      }
      throw new Error(`unhandled fetch: ${url}`);
    });
    const client = createTestQueryClient();
    render(<EngagementsHarness focusDistributionId="d2" focusReporting={true} />, { wrapper: (props) => <QueryClientWrapper client={client}>{props.children}</QueryClientWrapper> });

    // d2's own reporting period (2026-07), not d1's (2026-01), must be the one shown pre-expanded.
    await screen.findByText("2026-07");
    expect(screen.queryByText("2026-01")).not.toBeInTheDocument();
  });

  it.each(["OVERDUE_REMOVAL", "REMOVAL_UNVERIFIED"])(
    "round-3 fix: REMOVAL_CONFIRMED is reachable from %s, not only REMOVAL_CLAIMED/REMOVAL_REQUIRED - the domain's own REMOVAL_LEGAL_FROM permits it from all four non-terminal states",
    async (removalState) => {
      let currentState = removalState;
      const confirmCalls: Array<{ body: Record<string, unknown> }> = [];
      global.fetch = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/agent-referrals/engagements/e1")) {
          return {
            ok: true, status: 200, json: async () => ({
              engagement: { id: "e1", lifecycle_state: "ACTIVE", created_at: "now" },
              latest_revision: null, creative: null, distributions: [distributionRow(currentState)],
              reward_registry: null, effective_reward_snapshot: null, settlement: null,
              act: null, act_acceptance: null, act_dispute: null, payment_attempts: [],
            }),
          } as Response;
        }
        if (url.includes("/agent-referrals/distributions/d1/confirm-removal")) {
          confirmCalls.push({ body: JSON.parse(String(init?.body)) });
          currentState = "REMOVAL_CONFIRMED";
          return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
        }
        throw new Error(`unhandled fetch: ${url}`);
      });
      const user = userEvent.setup();
      const client = createTestQueryClient();
      render(<EngagementsHarness />, { wrapper: (props) => <QueryClientWrapper client={client}>{props.children}</QueryClientWrapper> });

      const evidenceInput = await screen.findByPlaceholderText("Ссылка на подтверждение снятия");
      await user.type(evidenceInput, "confirmed by operator after review");
      await user.click(screen.getByRole("button", { name: "Подтвердить снятие" }));
      await waitFor(() => expect(confirmCalls).toHaveLength(1));
      expect(confirmCalls[0].body).toEqual({ evidence_ref: "confirmed by operator after review" });
    },
  );

  it("round-3 fix: distribution fact intake exposes ended_at so the operator can record or correct the publication end date", async () => {
    const reportCalls: Array<{ body: Record<string, unknown> }> = [];
    global.fetch = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/agent-referrals/engagements/e1")) {
        return {
          ok: true, status: 200, json: async () => ({
            engagement: { id: "e1", lifecycle_state: "ACTIVE", created_at: "now" },
            latest_revision: null, creative: null, distributions: [distributionRow(null)],
            reward_registry: null, effective_reward_snapshot: null, settlement: null,
            act: null, act_acceptance: null, act_dispute: null, payment_attempts: [],
          }),
        } as Response;
      }
      if (url.endsWith("/agent-referrals/engagements/e1/distributions") && init?.method === "POST") {
        reportCalls.push({ body: JSON.parse(String(init.body)) });
        return { ok: true, status: 201, json: async () => ({ distribution_id: "d2" }) } as Response;
      }
      throw new Error(`unhandled fetch: ${url}`);
    });
    const user = userEvent.setup();
    const client = createTestQueryClient();
    render(<EngagementsHarness />, { wrapper: (props) => <QueryClientWrapper client={client}>{props.children}</QueryClientWrapper> });

    await user.type(await screen.findByLabelText("Идентификатор ресурса"), "new-channel-post");
    await user.type(screen.getByLabelText("Ссылка на публикацию"), "https://t.me/x/9");
    await user.type(screen.getByLabelText("Дата публикации"), "2026-09-01T10:00");
    await user.type(screen.getByLabelText("Дата окончания (если уже известна)"), "2026-09-10T10:00");
    await user.type(screen.getByLabelText("Ссылка на подтверждение"), "ev-new");
    await user.type(screen.getAllByLabelText("Канал")[0], "telegram");
    await user.click(screen.getByRole("button", { name: "Отправить" }));
    await waitFor(() => expect(reportCalls).toHaveLength(1));
    expect(reportCalls[0].body.ended_at).toBe(new Date("2026-09-10T10:00").toISOString());
  });
});

describe("Engagements (Agent Referrals admin console): act/payment operator chain", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; vi.restoreAllMocks(); });

  const emptyDistributionsDetail = (extra: Record<string, unknown>) => ({
    ok: true, status: 200, json: async () => ({
      engagement: { id: "e1", lifecycle_state: "ACTIVE", created_at: "now" },
      latest_revision: null, creative: null, distributions: [],
      reward_registry: null, effective_reward_snapshot: null,
      act: null, act_acceptance: null, act_dispute: null, payment_attempts: [],
      ...extra,
    }),
  } as Response);

  it("round-3 fix: the full PREPARED -> IN_PROGRESS -> MADE -> PENDING_DOCUMENT -> NPD receipt -> SETTLED operator path is reachable, and Begin Payment never reappears once payment has moved on", async () => {
    let stage: "PREPARED" | "IN_PROGRESS" | "PENDING_DOCUMENT" | "SETTLED" = "PREPARED";
    const beginCalls: Array<{ body: Record<string, unknown> }> = [];
    const madeCalls: Array<{ body: Record<string, unknown> }> = [];
    const npdReceiptCalls: Array<{ body: Record<string, unknown> }> = [];

    const settlementFor = () => ({
      id: "s1",
      status: stage === "PREPARED" ? "PREPARED" : stage === "IN_PROGRESS" ? "PREPARED" : stage === "PENDING_DOCUMENT" ? "PENDING_DOCUMENT" : "SETTLED",
      amount_kopecks: 10000,
      tax_mode_snapshot: "NPD",
    });
    const paymentAttemptsFor = () => {
      if (stage === "PREPARED") return [];
      if (stage === "IN_PROGRESS") return [{ id: "pa1", status: "IN_PROGRESS" }];
      if (stage === "PENDING_DOCUMENT") return [{ id: "pa1", status: "MADE" }];
      return [{ id: "pa1", status: "MADE" }];
    };

    global.fetch = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/agent-referrals/engagements/e1")) {
        return emptyDistributionsDetail({
          settlement: settlementFor(),
          act: { id: "act1", amount_kopecks: 10000, presented_at: "now" },
          act_acceptance: { accepted_amount_kopecks: 10000, created_at: "now" },
          payment_attempts: paymentAttemptsFor(),
        });
      }
      if (url.endsWith("/agent-referrals/payments/begin") && init?.method === "POST") {
        beginCalls.push({ body: JSON.parse(String(init.body)) });
        stage = "IN_PROGRESS";
        return { ok: true, status: 201, json: async () => ({ id: "pa1", status: "IN_PROGRESS" }) } as Response;
      }
      if (url.endsWith("/agent-referrals/payment-attempts/pa1/made") && init?.method === "POST") {
        madeCalls.push({ body: JSON.parse(String(init.body)) });
        stage = "PENDING_DOCUMENT";
        return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
      }
      if (url.endsWith("/agent-referrals/payment-attempts/pa1/npd-receipt") && init?.method === "POST") {
        npdReceiptCalls.push({ body: JSON.parse(String(init.body)) });
        stage = "SETTLED";
        return { ok: true, status: 201, json: async () => ({ ok: true }) } as Response;
      }
      throw new Error(`unhandled fetch: ${url}`);
    });

    const user = userEvent.setup();
    const client = createTestQueryClient();
    render(<EngagementsHarness />, { wrapper: (props) => <QueryClientWrapper client={client}>{props.children}</QueryClientWrapper> });

    // "Акт и выплата" is the payment panel; scope every query to it, since the always-present
    // "report a new distribution" form also has its own "Ссылка на подтверждение" field.
    const actPanel = () => (screen.getByText("Акт и выплата").closest("section") as HTMLElement);

    const beginButton = await screen.findByRole("button", { name: /Начать выплату/ });
    await user.click(beginButton);
    await waitFor(() => expect(beginCalls).toHaveLength(1));
    expect(beginCalls[0].body).toEqual({ settlement_id: "s1" });

    // IN_PROGRESS: the settlement itself is still PREPARED at this exact point (beginPayment never flips
    // settlement.status), so Begin Payment must stay hidden because of the activeAttempt guard, not the
    // settlement-status gate alone - otherwise the operator could invite a second concurrent begin-payment
    // click that only the backend's payment_attempts_active_unique constraint would catch.
    await waitFor(() => expect(within(actPanel()).getByText("IN_PROGRESS")).toBeInTheDocument());
    expect(within(actPanel()).queryByRole("button", { name: /Начать выплату/ })).not.toBeInTheDocument();
    const madeInput = within(actPanel()).getByLabelText("Ссылка на подтверждение");
    await user.type(madeInput, "payout confirmed via bank statement");
    await user.click(within(actPanel()).getByRole("button", { name: "Выплата совершена" }));
    await waitFor(() => expect(madeCalls).toHaveLength(1));
    expect(madeCalls[0].body).toEqual({ evidence_ref: "payout confirmed via bank statement" });

    // PENDING_DOCUMENT + NPD: the MADE attempt must stay visible with an NPD-receipt form, and Begin
    // Payment must not reappear despite there being no IN_PROGRESS/PAYOUT_UNKNOWN attempt any more.
    await within(actPanel()).findByText("PENDING_DOCUMENT");
    expect(within(actPanel()).queryByRole("button", { name: /Начать выплату/ })).not.toBeInTheDocument();
    await user.type(within(actPanel()).getByLabelText("Номер чека НПД"), "НПД-12345");
    await user.type(within(actPanel()).getByLabelText("Ссылка на подтверждение"), "receipt screenshot reviewed");
    await user.click(within(actPanel()).getByRole("button", { name: "Записать чек НПД" }));
    await waitFor(() => expect(npdReceiptCalls).toHaveLength(1));
    expect(npdReceiptCalls[0].body).toEqual({ receipt_reference: "НПД-12345", evidence_ref: "receipt screenshot reviewed" });

    // SETTLED: the terminal confirmation renders, no further payment actions are offered.
    await within(actPanel()).findByText("Выплата завершена.", { exact: false });
    expect(within(actPanel()).queryByRole("button", { name: /Начать выплату/ })).not.toBeInTheDocument();
    expect(within(actPanel()).queryByLabelText("Ссылка на подтверждение")).not.toBeInTheDocument();
  });
});
