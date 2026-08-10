import Image, { type StaticImageData } from "next/image";

import hero1 from "@/public/hero1.webp";
import hero2 from "@/public/hero2.webp";
import hero3 from "@/public/hero3.webp";
import hero4 from "@/public/hero4.webp";

type Point = readonly [x: number, y: number];

// The mask outline in objectBoundingBox units — fractions of the square
// container, so a value doubles as a CSS percentage. This is the single source
// of truth: both the clipPath and the image anchors below are derived from it,
// so nudging a vertex moves the matching image with it.
const MASK_OUTLINE = [
  [0, 0], //                  0 - top left
  [1, 0], //                  1 - top right
  [1, 0.615476], //           2 - right edge, where the broken line starts
  [0.869048, 0.764286], //    3 - shoulder
  [0.661905, 0.808333], //    4 - soft bend
  [0.502381, 0.934524], //    5 - valley, right corner
  [0.303571, 0.934524], //    6 - valley, left corner
  [0.17619, 0.861905], //     7 - spike
  [0, 1], //                  8 - bottom left
] as const satisfies readonly Point[];

const MASK_PATH = `M${MASK_OUTLINE.map(([x, y]) => `${x} ${y}`).join("L")}Z`;

const midpoint = (a: Point, b: Point): Point => [
  (a[0] + b[0]) / 2,
  (a[1] + b[1]) / 2,
];

// One image per corner of the broken line, ordered left to right. The two
// corners of the flat valley floor share a single image centred on the floor
// between them rather than getting one each.
// `weight` trims an image whose artwork fills its bounding box more densely
// than the rest, since equal box area then reads as oversized. hero3 covers 64%
// of its box against 37-52% for the others, and 0.85 brings it back into line.
const HERO_IMAGES: { src: StaticImageData; at: Point; weight?: number }[] = [
  { src: hero1, at: MASK_OUTLINE[7] },
  { src: hero2, at: midpoint(MASK_OUTLINE[6], MASK_OUTLINE[5]) },
  { src: hero3, at: MASK_OUTLINE[4], weight: 0.85 },
  { src: hero4, at: MASK_OUTLINE[3] },
];

// Side of the square each image is scaled to cover, as a fraction of the hero.
const IMAGE_SIZE = 0.25;

// The artwork ranges from wide landscape to tall portrait, so a shared width
// would leave the landscape pieces looking small and the portrait ones
// looming. Matching area instead — width * height stays IMAGE_SIZE² — keeps
// their visual weight even. Intrinsic dimensions come from the static import,
// so this stays correct if the files are swapped.
const widthPercent = ({ width, height }: StaticImageData, weight = 1) =>
  IMAGE_SIZE * weight * Math.sqrt(width / height) * 100;

export default function HeroTour() {
  return (
    <section className="relative z-10 w-full">
      <svg className="absolute h-0 w-0" aria-hidden="true">
        <defs>
          <clipPath id="hero-mask" clipPathUnits="objectBoundingBox">
            <path d={MASK_PATH} />
          </clipPath>
        </defs>
      </svg>

      <div className="relative w-full aspect-square overflow-hidden [clip-path:url(#hero-mask)]">
        {/* data-hero-video is the handle AssetPreloader reads buffering
            progress from — it watches this element instead of re-fetching the
            URL, which would download the file twice. */}
        <video
          data-hero-video
          preload="auto"
          className="h-full w-full object-cover"
          src="https://zhjrb3dyh4.ufs.sh/f/kTOk4z0nYjRrwE5REnNvr7CulqYDdzFVZUTmpAef0anscMBL"
          autoPlay
          loop
          muted
          playsInline
        />
      </div>

      {/* Covers exactly the square above, so a percentage here means the same
          thing it means inside the clipPath. Kept outside the clipped element
          on purpose — clip-path cuts every descendant, and these are meant to
          spill past the broken edge. */}
      <div className="pointer-events-none absolute inset-0">
        {HERO_IMAGES.map(({ src, at, weight }) => (
          <Image
            key={src.src}
            src={src}
            alt=""
            aria-hidden="true"
            sizes={`${Math.ceil(widthPercent(src, weight))}vw`}
            className="absolute h-auto -translate-x-1/2 -translate-y-1/2"
            style={{
              left: `${at[0] * 100}%`,
              top: `${at[1] * 100}%`,
              width: `${widthPercent(src, weight)}%`,
            }}
          />
        ))}
      </div>
    </section>
  );
}
