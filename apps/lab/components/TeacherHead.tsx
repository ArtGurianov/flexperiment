// head.svg animates with SMIL (<animate>, 2s loop, repeatCount="indefinite").
// SMIL runs when the file is loaded as its own image document, which a plain
// <img> does — but next/image would route it through the optimizer and flatten
// the animation away, so this one deliberately stays an <img>.
//
// That same choice is why reduced motion is served as a second file rather than
// a runtime pause: an <img>'s document is not scriptable, so there is no handle
// to call pauseAnimations() on. head-still.svg is generated from the same
// payloads with the <animate> elements removed, which leaves exactly the t=0
// frame the animated file paints first anyway.
//
// <picture> rather than a client-side src swap: the browser evaluates the
// media query before it fetches, so the right file is the only one requested
// and this stays a server component with no hydration or media subscription.
//
// Intrinsic dimensions are passed to reserve layout space and avoid a shift
// once the file lands.
export default function TeacherHead({ className = "" }: { className?: string }) {
  return (
    // NOT display:contents. <source> is display:inline rather than none — it
    // stays invisible only because it has no content — so promoting the
    // picture's children to grid items handed the <source> a cell of its own
    // and bumped the portrait onto a second row. Letting <picture> be the grid
    // item instead keeps the box identical to the bare <img> it replaced: it is
    // blockified by the grid, stretches to the column, and takes its height
    // from the image.
    <picture>
      <source
        media="(prefers-reduced-motion: reduce)"
        srcSet="/head-still.svg"
        type="image/svg+xml"
      />
      <img
        src="/head.svg"
        alt=""
        aria-hidden="true"
        width={480}
        height={680}
        loading="lazy"
        className={`pointer-events-none block h-auto max-w-none select-none ${className}`}
      />
    </picture>
  );
}
