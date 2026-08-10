import type { ComponentPropsWithoutRef } from "react";

import { cn } from "@/lib/cn";

// A translucent slab that carries its own contrast, so sections can sit on the
// site background unaltered instead of baking a darkened patch into artwork.
// The glow stays directional — offset left and down, the way it falls in the
// poster — but is soft rather than a hard offset edge.
/** The surface itself, exported so other containers (the accordion) can sit on
 *  the identical fill and glow instead of re-declaring — and stay matched if
 *  either value is ever retuned. */
export const DARK_PANEL_SURFACE =
  "bg-panel shadow-[-10px_10px_24px_rgb(202_255_86_/_0.3),-16px_16px_48px_rgb(202_255_86_/_0.18)]";

// Merged through `cn` rather than concatenated, so a caller passing its own
// background or shadow actually replaces this one instead of leaving two
// competing declarations whose winner depends on stylesheet order.
export default function DarkPanel({
  className,
  ...props
}: ComponentPropsWithoutRef<"div">) {
  return <div className={cn(DARK_PANEL_SURFACE, className)} {...props} />;
}
