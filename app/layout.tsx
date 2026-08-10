import type { Metadata } from "next";
import { Geist, Geist_Mono, Shafarik } from "next/font/google";

import AssetPreloader from "@/components/AssetPreloader";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Shafarik ships a single 400 weight, so any emphasis has to come from size or
// colour rather than a bolder cut.
const shafarik = Shafarik({
  variable: "--font-shafarik",
  subsets: ["cyrillic", "latin"],
  weight: "400",
});

export const metadata: Metadata = {
  title: "Flextatic",
  description: "Flextatic",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${shafarik.variable} h-full antialiased bg-pattern bg-repeat`}
    >
      {/* The centered column is this inner wrapper, not <body>. When a modal
          dialog locks scroll, react-remove-scroll rewrites body's computed
          auto margins into padding — with the column on <body> that meant
          2x344px of padding against a max-w-lg cap, and since Tailwind sets
          box-sizing: border-box, the content box collapsed and the whole page
          jumped to the left edge. A full-width body has no auto margins to
          convert, so the rewrite becomes a no-op. */}
      <body className="min-h-full w-full flex flex-col">
        {/* React hoists these into <head>, so they land in the streamed HTML
            and the preload scanner issues the requests before it has parsed the
            CSS that references them — and before it reaches the video element
            further down the body. Referenced only as CSS backgrounds
            otherwise, neither would be discovered until its rule matched.
            Together they are ~71KB, far cheaper than the delay of finding them
            late. */}
        <link rel="preload" as="image" href="/noize.webp" fetchPriority="high" />
        <link
          rel="preload"
          as="image"
          href="/background.webp"
          fetchPriority="high"
        />
        <AssetPreloader />
        <div className="mx-auto flex w-full max-w-lg flex-1 flex-col bg-site bg-cover bg-center bg-no-repeat bg-fixed">
          {children}
        </div>
      </body>
    </html>
  );
}
