import CtaButton from "@/components/CtaButton";
import PaymentCta from "@/components/PaymentCta";

const NAV_LINKS = [
  { label: "Кто", href: "#teacher" },
  { label: "Программа", href: "#program" },
  { label: "Вопросы", href: "#faq" },
];

// z-40 is deliberate: the dialog portals in at z-50 and has to cover this.
// Fullscreen video needs no accounting — the Fullscreen API promotes the
// element to the browser's top layer, which sits above every stacking context
// regardless of z-index.
export default function Navbar() {
  return (
    // The sticky element is a zero-height wrapper, so the bar overlays the
    // content below instead of reserving a strip at the top of the page. Kept
    // sticky rather than switched to fixed so it still inherits the centred
    // column's width instead of needing to re-derive it from the viewport.
    <div className="sticky top-0 z-40 h-0">
      <nav className="@container flex items-center justify-between gap-[2cqw] bg-[rgb(22_20_18_/_0.5)] px-4 py-2 backdrop-blur-sm">
        {NAV_LINKS.map(({ label, href }) => (
          <CtaButton
            key={href}
            href={href}
            // Same CTA treatment minus the frame: border and fill dropped,
            // underlined instead, hover highlight inherited unchanged.
            className="w-auto border-0 bg-transparent px-1 py-1 text-[clamp(0.62rem,2.9cqw,0.95rem)] underline underline-offset-4"
          >
            {label}
          </CtaButton>
        ))}

        <PaymentCta className="w-auto border-2 px-2 py-1 text-[clamp(0.62rem,2.9cqw,0.95rem)]">
          Города × Даты
        </PaymentCta>
      </nav>
    </div>
  );
}
