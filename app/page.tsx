import AssetPreloader from "@/components/AssetPreloader";
import FaqSection from "@/components/FaqSection";
import HeroSiberia from "@/components/HeroSiberia";
import HeroTour from "@/components/HeroTour";
import HeroVideo from "@/components/HeroVideo";
import Navbar from "@/components/Navbar";
import ProgramSection from "@/components/ProgramSection";
import Separator from "@/components/Separator";
import TeacherSection from "@/components/TeacherSection";
import WorkshopIntro from "@/components/WorkshopIntro";

export default function Home() {
  return (
    <>
      {/* Lives on the page rather than in the root layout: it gates on
          [data-hero-video], which only this route renders, so running it
          layout-wide meant every other route — 404s included — sat behind a
          loader waiting for a video that was never there. */}
      <AssetPreloader />

      {/* Ahead of the navbar in the DOM so it is the very first tab stop.
          Visible only while focused, and above the loader's z-[100] — at z-50
          it could take focus while sitting completely behind the overlay, which
          is the one moment a keyboard user most wants a way out. */}
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
          FLEXTATIC - тур мастер-классов по флексингу по Сибири, 2026
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
        <FaqSection />
      </main>
    </>
  );
}
