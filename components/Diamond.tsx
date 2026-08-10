import { cn } from "@/lib/cn";

/**
 * The rotated square used as a list marker.
 *
 * Drawn rather than delegated to `list-style`: one call site is inside a
 * <button> (where <ol>/<li> is invalid), and Tailwind's Preflight strips list
 * markers globally anyway, so a bare list renders nothing.
 *
 * Two elements on purpose. A shadow on the marker has to match the adjacent
 * text's `text-shadow`, which is a screen-space offset - but a box-shadow or a
 * filter applied to the rotated node itself resolves in that node's own
 * coordinates and comes out thrown 45 degrees off with it. Rotating the inner
 * square and filtering the unrotated wrapper keeps the offset pointing the same
 * way as the text's.
 */
export default function Diamond({
  className,
  wrapperClassName,
}: {
  /** Size and fill of the marker itself, e.g. `size-[0.42em] bg-acid`. */
  className?: string;
  /** Applied to the unrotated wrapper - spacing, and any drop-shadow. */
  wrapperClassName?: string;
}) {
  return (
    <span aria-hidden="true" className={cn("block", wrapperClassName)}>
      <span className={cn("block rotate-45", className)} />
    </span>
  );
}
