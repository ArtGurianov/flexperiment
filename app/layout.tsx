import type { Metadata, Viewport } from "next";
import { Geist_Mono, Shafarik } from "next/font/google";

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

const SITE_URL = "https://flexperiment.ru";
const TITLE = "FLEXPERIMENT - мастер-классы по experimental и flexing в Сибири, 2026";
const DESCRIPTION =
  "Тур мастер-классов от Арта Гурьянова по EXPERIMENTAL через FLEXING: изоляции тела, иллюзии в танце, импровизация и поиск собственного стиля. Для новичков и танцоров с опытом, растяжка не нужна.";

export const metadata: Metadata = {
  // Without metadataBase, Next resolves relative OG/Twitter asset paths against
  // localhost in development and warns in production.
  metadataBase: new URL(SITE_URL),
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    locale: "ru_RU",
    url: SITE_URL,
    siteName: "FLEXPERIMENT",
    title: TITLE,
    description: DESCRIPTION,
  },
  twitter: {
    // `summary` until there is an image to show. summary_large_image promises a
    // 1200x630 card, and with neither openGraph.images nor an
    // app/opengraph-image file the platform has nothing to fill it with — which
    // renders worse than the text card this asks for. Add
    // app/opengraph-image.png (Next wires it into both og:image and
    // twitter:image) and switch this back.
    card: "summary",
    title: TITLE,
    description: DESCRIPTION,
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
      // motion-safe, not a bare scroll-smooth: animated scrolling is a common
      // vestibular trigger, and this variant drops back to an instant jump for
      // anyone who has asked their OS to reduce motion.
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
            height instead of one screen. A real position: fixed element is
            reliably viewport-pinned on iOS, so the background lives on its
            own layer behind the content instead of as a background-attachment
            on the scrolling column. */}
        <div
          aria-hidden
          // left-0/right-0 (from inset-0) span the full viewport so the
          // mx-auto + max-w-lg pair has room to center this layer the same
          // way the content column centers itself - without it the fixed
          // element has no containing block to center within and just fills
          // the whole viewport width.
          className="fixed inset-0 -z-10 mx-auto max-w-lg bg-site bg-cover bg-center bg-no-repeat"
        />
        <div className="mx-auto flex w-full max-w-lg flex-1 flex-col">
          {children}
        </div>
      </body>
    </html>
  );
}
