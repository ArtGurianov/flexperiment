import AssetPreloader from "@/components/AssetPreloader";
import FaqSection from "@/components/FaqSection";
import Footer from "@/components/Footer";
import HeroSiberia from "@/components/HeroSiberia";
import HeroTour from "@/components/HeroTour";
import HeroVideo from "@/components/HeroVideo";
import Navbar from "@/components/Navbar";
import PaymentNotice from "@/components/PaymentNotice";
import { Price } from "@/components/Price";
import ProgramSection from "@/components/ProgramSection";
import Separator from "@/components/Separator";
import TeacherSection from "@/components/TeacherSection";
import WorkshopIntro from "@/components/WorkshopIntro";

export default function Home() {
  return (
    // Lives on the page rather than in the root layout: it gates on
    // [data-hero-video], which only this route renders, so running it
    // layout-wide meant every other route — 404s included — sat behind a loader
    // waiting for a video that was never there. It wraps the page rather than
    // sitting beside it so it can inert what it covers.
    <AssetPreloader>
      {/* Ahead of the navbar in the DOM so it is the very first tab stop.
          Visible only while focused.

          z-[110] puts it above the loader's z-[100]. That is not about the load
          itself — the wrapper inside AssetPreloader inerts this link along with
          everything else while the overlay covers the page, so it cannot take
          focus then at all. It matters for the fade window: inert lifts the
          moment the fade starts, so for those 500ms the page is interactive
          while the overlay is still painting over it. */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[110] focus:bg-acid focus:px-4 focus:py-2 focus:font-display focus:text-ink focus:uppercase"
      >
        Перейти к содержанию
      </a>

      {/* Outside <main> on purpose: a navigation landmark nested inside the
          main landmark is not reachable as a site-level nav. Still the first
          flex child of the column, so nothing moves. */}
      <Navbar />

      {/* overflow-x-clip rather than -hidden: clip does not turn the element
          into a scroll container and leaves the vertical axis alone, so
          position:sticky keeps working inside sections. */}
      {/* tabIndex -1 makes <main> a programmatic focus target. Without it the
          skip link only moves the fragment: browsers scroll to a non-focusable
          element but leave keyboard focus where it was, so the next Tab
          continued through the navbar the link was meant to skip. */}
      <main
        id="main"
        tabIndex={-1}
        className="flex flex-1 flex-col overflow-x-clip outline-none"
      >
        {/* The hero is artwork end to end, so the page had no h1 at all and
            its first heading was an h2 halfway down. This names the page for
            assistive tech and search without altering the composition. */}
        <h1 className="sr-only">
          FLEXPERIMENT - тур мастер-классов по флексингу по Сибири, 2026
        </h1>

        <HeroTour />
        <HeroSiberia />
        <HeroVideo />
        <WorkshopIntro />
        <Separator />
        <TeacherSection />
        <Separator />
        <ProgramSection />
        <Separator />
        <Price />
        <Separator />
        <FaqSection />
      </main>

      {/* Outside <main> for the same reason the navbar is: a <footer> nested in
          the main landmark is not exposed as the page's contentinfo. Inside
          AssetPreloader rather than the root layout, though — the loader covers
          the viewport but only inerts what this wraps, so a footer hoisted to
          the layout would be tabbable behind an overlay nobody can see past. */}
      <Footer />

      {/* Mounted once for the whole page. All three booking CTAs report a
          failed dialog load through the shared store rather than each rendering
          its own banner, which previously stacked two identical alerts — and
          announced them twice — when more than one failed inside the timeout. */}
      <PaymentNotice />
    </AssetPreloader>
  );
}
