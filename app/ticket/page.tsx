import type { Metadata } from "next";

import TicketViewer from "./TicketViewer";

/**
 * A ticket is a per-order capability URL: the page itself is a shell that reads
 * a fragment the server never sees, so there is nothing here worth indexing and
 * an indexed shell would be a dead result.
 *
 * Owning a title and robots directive here is also what stops this route from
 * inheriting the home page's canonical, description and og:url — noindex and
 * rel=canonical are separate controls, and pointing a utility route's canonical
 * at "/" was the actual defect, not the absence of a directive.
 */
export const metadata: Metadata = {
  title: "Билет | FLEXPERIMENT",
  description: "Просмотр оформленного билета FLEXPERIMENT по персональной ссылке.",
  robots: { index: false, follow: false },
};

export default function TicketPage() { return <TicketViewer />; }
