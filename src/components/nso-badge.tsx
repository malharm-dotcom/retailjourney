// The NSO marker. One component, because a store opening has to read the same
// wherever it appears — the Warehouse queue (a client table) and the /orders
// list (a server page) both render it.
//
// No hooks and no client state, so it drops into either without a boundary.

/**
 * NSO = New Store Opening.
 *
 * The tooltip carries the whole reason the badge exists: these orders have no
 * rulebook timeline and no fulfilment TAT, so they never read as breaching or
 * overdue, and their delivery is driven by the store's opening date rather
 * than by a deadline the floor is working to. Without the marker they are
 * indistinguishable from a replenishment carrying twenty times fewer units.
 */
export function NsoBadge({ className }: { className?: string }) {
  return (
    <span
      className={`inline-block rounded-md bg-ink/10 px-1.5 py-0.5 text-meta font-bold text-ink${className ? ` ${className}` : ""}`}
      title="New Store Opening — no rulebook timeline and no fulfilment TAT, so it carries no deadline and can never read as breaching. Delivery is driven by the store's opening date."
    >
      NSO
    </span>
  );
}
