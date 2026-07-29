import Link from "next/link";
import { Icon } from "@/components/icon";

/**
 * Not-found INSIDE the app shell.
 *
 * `orders/[soNumber]/page.tsx` calls `notFound()` for an unrecognised SO, and the
 * nearest boundary used to be the root `not-found.tsx` — which renders outside the
 * shell, so a mistyped order number threw the user out of the application: no
 * sidebar, no top bar, no facility switcher, one button back to the Control Tower.
 * A typo is the most ordinary thing a person does with an order number and it does
 * not warrant an ejection. This keeps the chrome and offers the two places the
 * record might actually be.
 */
export default function AppNotFound() {
  return (
    <div className="flex min-h-[52vh] flex-col items-center justify-center gap-4 py-16 text-center">
      <span className="grid h-12 w-12 place-items-center rounded-full bg-pending-bg text-ink-soft">
        <Icon name="magnifer-zoom-in-bold-duotone" size={24} />
      </span>
      <h1 className="font-display text-[27px] font-bold leading-tight tracking-tight">That record isn&rsquo;t on the track</h1>
      <p className="max-w-[46ch] text-sm leading-relaxed text-mute">
        Nothing here matches that SO number. It may belong to a facility outside your current view, or it may simply be
        a typo — the order lookup searches SO, DC and LR together.
      </p>
      <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
        <Link
          href="/reports/order-lookup"
          className="flex min-h-[38px] items-center gap-2 rounded-control bg-ink px-4 py-2.5 text-ui font-semibold text-paper transition-colors duration-150 ease-ui hover:bg-ink/85"
        >
          <Icon name="magnifer-linear" size={15} />
          Search every order
        </Link>
        <Link
          href="/in-transit"
          className="flex min-h-[38px] items-center gap-2 rounded-control border border-line-control bg-paper px-4 py-2.5 text-ui font-semibold text-ink-soft transition-colors duration-150 ease-ui hover:border-sage hover:bg-sage-soft hover:text-sage"
        >
          Back to the board
        </Link>
      </div>
    </div>
  );
}
