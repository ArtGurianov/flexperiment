import CtaButton from "@/components/CtaButton";
import { cn } from "@/lib/cn";

/**
 * "Open the catalogue of cities and dates."
 *
 * A semantic primitive, not a home-page CTA. It always renders a real
 * <a href="/schedule">, so the same component is correct in the navbar, the
 * footer, the intro and the price section — on the home page, on an event
 * page, or anywhere else — without any of them knowing which document they are
 * currently in.
 *
 * On the home page ModalRouteController intercepts the plain left-click and
 * opens /schedule as a drawer. Anywhere without that controller, and for any
 * modified click, middle-click or crawler, it is ordinary navigation to a real
 * static page. Nothing here has to know which of those is happening.
 *
 * This exists because PaymentCta used to mean two unrelated things — "show me
 * the list of cities" and "start paying for this date". After /schedule those
 * are different actions on different objects, so they are different components.
 * PaymentCta now means only the second.
 */
export default function ScheduleLink({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <CtaButton href="/schedule" className={cn(className)}>
      {children}
    </CtaButton>
  );
}
