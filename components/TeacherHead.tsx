// head.svg animates with SMIL (<animate>, 2s loop). SMIL runs when the file is
// loaded as its own image document, which a plain <img> does — but next/image
// would route it through the optimizer and flatten the animation away, so this
// one deliberately stays an <img>. Intrinsic dimensions are passed to reserve
// layout space and avoid a shift once the 468KB file lands.
export default function TeacherHead({ className = "" }: { className?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/head.svg"
      alt=""
      aria-hidden="true"
      width={480}
      height={680}
      loading="lazy"
      className={`pointer-events-none block h-auto max-w-none select-none ${className}`}
    />
  );
}
