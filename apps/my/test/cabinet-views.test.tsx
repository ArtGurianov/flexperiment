// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { fixtureCabinetSource } from "../components/cabinet/data";
import { CoursesView, OrdersView, ProfileView, TicketsView } from "../components/cabinet/views";

afterEach(cleanup);
const PLATFORM = "https://flexperiment.test";

describe("FLEX-123 cabinet views on fixtures", () => {
  it("LMS profile: courses show access and the started fact, separate from payment and refund state", async () => {
    const lms = fixtureCabinetSource("lms");
    render(<><CoursesView result={await lms.courses()} platformOrigin={PLATFORM} /><OrdersView result={await lms.orders()} /></>);
    const courses = within(screen.getByRole("region", { name: "Мои курсы" }));
    expect(courses.getByText("Основы флексинга")).toBeInTheDocument();
    expect(courses.getByText("Доступ: Куплен")).toBeInTheDocument();
    expect(courses.getByText("· Начат")).toBeInTheDocument();
    expect(courses.getByRole("link", { name: "Продолжить: Изоляции: вступление" }))
      .toHaveAttribute("href", `${PLATFORM}/auth/lms/start?next=%2Fcourses%2Fflex-basics%2Flessons%2Fisolation-intro`);
    expect(courses.getByRole("link", { name: "Начать" })).toHaveAttribute("href", `${PLATFORM}/auth/lms/start?next=%2Fcourses%2Fmusicality-free`);
    expect(courses.getByText("Доступ: Бесплатная запись")).toBeInTheDocument();
    const orders = within(screen.getByRole("region", { name: "Заказы" }));
    expect(orders.getByText("Возвращён")).toBeInTheDocument();
    expect(orders.getByText("Оплачен")).toBeInTheDocument();
    expect(courses.queryByText(/Возвращён|Оплачен/)).not.toBeInTheDocument();
  });

  it("LAB profile: tickets list with an entry point for active tickets only, no QR", async () => {
    const lab = fixtureCabinetSource("lab");
    const { container } = render(<TicketsView result={await lab.tickets()} />);
    const links = screen.getAllByRole("link", { name: "Открыть билет" });
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute("href", "/tickets/ord_lab_fixture_0001");
    expect(screen.getByText(/Ещё не выдан/)).toBeInTheDocument();
    expect(container.querySelector("img, canvas, svg")).toBeNull();
  });

  it("does not link a historical ticket whose own capability is required", async () => {
    const result = await fixtureCabinetSource("lab").tickets();
    if (result.status !== "ok") throw new Error("fixture unavailable");
    render(<TicketsView result={{ status: "ok", data: result.data.map(ticket => ({ ...ticket, viewPath: null })) }} />);
    expect(screen.queryByRole("link", { name: "Открыть билет" })).not.toBeInTheDocument();
  });

  it("shows the full e-mail only on the my profile page", async () => {
    render(<ProfileView result={await fixtureCabinetSource("lab").profile()} />);
    expect(screen.getByText("lab-guest@example.test")).toBeInTheDocument();
    expect(screen.getByText("Не указано")).toBeInTheDocument();
  });

  it("renders pending, consent and error states instead of empty lists", () => {
    render(<>
      <CoursesView result={{ status: "not-yet-available" }} platformOrigin={PLATFORM} />
      <TicketsView result={{ status: "consent-required" }} />
      <OrdersView result={{ status: "unavailable" }} />
    </>);
    expect(screen.getByText("Раздел «курсы» скоро появится в кабинете.")).toBeInTheDocument();
    expect(screen.getByText(/подтвердите согласия аккаунта/)).toBeInTheDocument();
    expect(screen.getByText(/Не удалось загрузить заказы/)).toBeInTheDocument();
    expect(screen.queryByText("Заказов пока нет.")).not.toBeInTheDocument();
  });
});
