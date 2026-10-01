// A repeating CSS background rather than an <img>: at this height the band is a
// texture, not a picture, so it should tile across the column instead of being
// squashed to fit once. `auto 100%` scales each tile to the strip's height and
// lets its width follow, which is what makes the repeat seamless at any width.
export default function Separator() {
  return (
    <div
      aria-hidden="true"
      className="h-16 w-full bg-[url('/separator.webp')] bg-size-[auto_100%] bg-repeat-x"
    />
  );
}
