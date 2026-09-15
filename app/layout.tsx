import type { Metadata, Viewport } from "next";
import { Geist_Mono, Monomakh as Shafarik } from "next/font/google";
import { Suspense } from "react";
import AnalyticsConsent from "@/components/AnalyticsConsent";
import ReferralCapture from "@/components/ReferralCapture";
import { OPEN_GRAPH_BASE, SITE_ORIGIN, TWITTER_CARD } from "@/lib/seo/site";

import "./globals.css";

// Shafarik ships a single 400 weight, so any emphasis has to come from size or
// colour rather than a bolder cut.
//
// adjustFontFallback is off because Shafarik is missing from the metrics table
// Next ships (`calculateSizeAdjustValues` throws on it, where Geist and Inter
// resolve). Next only consults that table when the flag is on, so leaving it
// enabled just retried a lookup that always failed and logged a warning each
// compile - the size-adjusted fallback was never produced either way. The
// explicit list below is what the browser now falls back to instead.
const shafarik = Shafarik({
  variable: "--font-shafarik",
  subsets: ["cyrillic", "latin"],
  weight: "400",
  adjustFontFallback: false,
  fallback: ["Georgia", "Times New Roman", "serif"],
});

// Carries the footer's legal links and company details, where the display face
// is the wrong tool: those are long titles and long digit strings set small in
// a narrow column, and Shafarik has neither the width nor the figure clarity
// for them. `cyrillic` is the load-bearing subset — the whole site is Russian,
// and a mono without it would fall straight back to the system stack.
//
// No `weight`, so this resolves to the variable font: one file covering the
// whole axis rather than a separate request per cut.
const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["cyrillic", "latin"],
});

/**
 * Only genuinely global metadata belongs here.
 *
 * Next merges metadata shallowly from the root layout down to the leaf, so any
 * field this object declares is inherited verbatim by every route that does not
 * override it. That is how `alternates: { canonical: "/" }` came to be emitted
 * on /ticket, /payment/success, /refund and the 404 page, each of them
 * declaring the home page as its canonical URL, together with the home page's
 * description and og:url.
 *
 * The fix is ownership, not per-route patching: a page-specific fact is
 * declared by the page that owns it (see app/page.tsx). What stays is what is
 * true of every document on the site.
 */
export const metadata: Metadata = {
  // Without metadataBase, Next resolves relative OG/Twitter asset paths against
  // localhost in development and warns in production.
  metadataBase: new URL(SITE_ORIGIN),
  openGraph: OPEN_GRAPH_BASE,
  // Search Console / Yandex Webmaster verification is deliberately absent
  // rather than stubbed. No HTML meta token exists in this repository, but DNS
  // verification is invisible from a repository and may already be in place —
  // check each property's console before adding anything, and prefer a DNS TXT
  // record, which covers the apex, www and every subdomain and survives a
  // redeploy. If a meta token is ever genuinely needed, it goes here as
  // `verification: { google, yandex }` read from build-time values; a
  // hardcoded placeholder would be worse than nothing, because a wrong token
  // fails verification silently.
  twitter: {
    // Now backed by real images. app/opengraph-image.png emits og:image and
    // app/twitter-image.png emits twitter:image — the opengraph-image
    // convention alone does NOT produce twitter:image, which is why both files
    // exist (verified in the built HTML; see the export conformance test).
    card: TWITTER_CARD,
  },
};

export const viewport: Viewport = {
  // Matches the page's own dark surface, so mobile browser chrome does not
  // flash a light bar above a black page.
  themeColor: "#12100e",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="ru"
      data-scroll-behavior="smooth"
      // motion-safe, not a bare scroll-smooth: animated scrolling is a common
      // vestibular trigger, and this variant drops back to an instant jump for
      // anyone who has asked their OS to reduce motion.
      //
      // overscroll-y-none disables the iOS rubber-band bounce at the top/
      // bottom edges. During that bounce iOS shifts the whole page - fixed
      // elements included - relative to the viewport, which briefly exposed
      // the fixed bg-site layer past its intended edge. No bounce, no gap to
      // expose it through.
      className={`${shafarik.variable} ${geistMono.variable} h-full antialiased bg-pattern bg-repeat motion-safe:scroll-smooth`}
    >
      {/* The centered column is this inner wrapper, not <body>. When a modal
          dialog locks scroll, react-remove-scroll rewrites body's computed
          auto margins into padding - with the column on <body> that meant
          2x344px of padding against a max-w-lg cap, and since Tailwind sets
          box-sizing: border-box, the content box collapsed and the whole page
          jumped to the left edge. A full-width body has no auto margins to
          convert, so the rewrite becomes a no-op. */}
      <body className="min-h-full w-full flex flex-col">
        <Suspense fallback={null}><ReferralCapture /></Suspense>
        <Suspense fallback={null}><AnalyticsConsent /></Suspense>
        {/* React hoists these into <head>, so they land in the streamed HTML
            and the preload scanner issues the requests before it has parsed the
            CSS that references them - and before it reaches the video element
            further down the body. Referenced only as CSS backgrounds
            otherwise, neither would be discovered until its rule matched.
            Together they are ~71KB, far cheaper than the delay of finding them
            late. The preconnect opens the TLS connection to the video host in
            parallel, so the <video> below does not pay for the handshake. */}
        <link rel="preload" as="image" href="/noize.webp" fetchPriority="high" />
        <link
          rel="preload"
          as="image"
          href="/background.webp"
          fetchPriority="high"
        />
        <link rel="preconnect" href="https://flexperiment.s3.cloud.ru" />

        {/* iOS Safari doesn't keep background-attachment: fixed pinned to the
            viewport the way desktop browsers do - it paints bg-cover against
            the element's own box, and that box here would be flex-1 (full
            page height), so the image stretched to cover the whole scroll
            height instead of one screen. position: fixed alone would dodge
            that, but iOS's rubber-band bounce can visually detach a fixed
            compositor layer from the document for a moment, exposing pixels
            past its edge at the top/bottom - and overscroll-behavior isn't an
            option since some browsers use that gesture for pull-to-refresh.
            position: sticky gets the same "stays put while the page scrolls"
            look, but as real in-flow, clipped document content rather than a
            viewport-anchored layer - there's no separate compositor box for
            the bounce to reveal.

            The anchor itself is h-0: a margin-bottom trick to cancel a real
            height would have needed the negative margin to actually offset
            the item's contribution to the flex column above it, which isn't
            reliable across browsers - h-0 sidesteps that by never taking up
            layout space in the first place. The visible layer is its
            absolutely-positioned child, sized explicitly via h-dvh rather
            than inset-y-0 (pinning both top and bottom to a 0-height parent
            would just collapse it back to 0 too). */}
        <div aria-hidden className="sticky top-0 -z-10 h-0 overflow-visible">
          <div className="absolute inset-x-0 top-0 mx-auto h-dvh max-w-lg overflow-hidden">
            <div className="h-full bg-site bg-cover bg-center bg-no-repeat" />
          </div>
        </div>
        <div className="mx-auto flex w-full max-w-lg flex-1 flex-col">
          {children}
        </div>
      </body>
    </html>
  );
}
