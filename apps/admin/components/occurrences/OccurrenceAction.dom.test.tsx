import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestQueryClient, QueryClientWrapper } from "../../lib/test-query-client";
import { OccurrenceAction } from "./OccurrenceAction";

describe("OccurrenceAction (B4)", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; vi.restoreAllMocks(); });

  it("headlines the human action label and a consequence sentence, never the raw target-state enum", () => {
    const client = createTestQueryClient();
    render(
      <OccurrenceAction
        action={{ occurrence: { id: "occ-1", title: "Мастер-класс", admin_revision: 1 }, label: "Опубликовать", patch: { visibility: "PUBLISHED" } }}
        close={() => {}}
        done={() => {}}
      />,
      { wrapper: (props) => <QueryClientWrapper client={client}>{props.children}</QueryClientWrapper> },
    );

    expect(screen.getByRole("heading", { name: "Опубликовать" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "PUBLISHED" })).not.toBeInTheDocument();
    expect(screen.getByText(/публичном каталоге/)).toBeInTheDocument();
  });
});
