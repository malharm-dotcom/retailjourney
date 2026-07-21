"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { advanceOrderStatus } from "@/app/actions";
import { Icon } from "@/components/icon";
import { JourneyLink } from "@/components/journey-link";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import {
  Dropdown,
  DropdownContent,
  DropdownItem,
  DropdownSeparator,
  DropdownTrigger,
} from "@/components/ui/dropdown";
import { Button, Field, Input, Select } from "@/components/ui/primitives";
import { REQUIRED_CAPTURES, STATUS_LABEL, WH_FLOW, WH_TRANSITIONS } from "@/lib/journey";
import { LOGISTICS_PARTNERS, type Order, type OrderStatus, type OrderType } from "@/lib/types";
import { WH_STATUS_VISUAL, cn } from "@/lib/ui";

export interface KanbanCard {
  so: string;
  store: string;
  qty: number;
  type: OrderType;
  priority?: string;
  campaign?: string;
  status: OrderStatus;
  facility: string;
  due?: "today" | "overdue";
  ageDays: number;
  boxCount?: number;
  weightKg?: number;
  invoice?: string;
}

const LANES: OrderStatus[] = [...WH_FLOW, "ON_HOLD"];

/** Cards rendered per lane before "Show more" — keeps the DOM bounded at live
 *  volume (hundreds of orders per lane) while the lane header shows the true count. */
const LANE_PAGE = 25;

interface PendingMove {
  card: KanbanCard;
  to: OrderStatus;
}

export function Kanban({
  cards,
  canEdit,
  terminalCount,
}: {
  cards: KanbanCard[];
  canEdit: boolean;
  terminalCount: number;
}) {
  const router = useRouter();
  const [move, setMove] = useState<PendingMove | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [note, setNote] = useState("");
  const [pending, startTransition] = useTransition();
  // Live volume is hundreds of cards per lane (RTS-Logic alone carries 150+);
  // rendering them all is a DOM/layout problem, so lanes page in increments.
  const [laneShown, setLaneShown] = useState<Record<string, number>>({});

  const byLane = useMemo(() => {
    const m = new Map<OrderStatus, KanbanCard[]>();
    for (const lane of LANES) m.set(lane, []);
    for (const c of cards) m.get(c.status)?.push(c);
    for (const lane of LANES)
      m.get(lane)!.sort((a, b) => (a.due === "overdue" ? -1 : 0) - (b.due === "overdue" ? -1 : 0) || b.ageDays - a.ageDays);
    return m;
  }, [cards]);

  const requestMove = (card: KanbanCard, to: OrderStatus) => {
    const fields = REQUIRED_CAPTURES[to] ?? [];
    const needsConfirm = ["ON_HOLD", "CANCELLED", "UNFULFILLABLE"].includes(to);
    if (fields.length === 0 && !needsConfirm) {
      commit(card, to, {});
      return;
    }
    // Values already on the order (captured earlier or synced) prefill the
    // dialog — in-flight orders never re-type what the floor already entered.
    const known: Record<string, string | number | undefined> = {
      boxCount: card.boxCount,
      weightKg: card.weightKg,
      saleInvoiceNumber: card.invoice,
    };
    const prefill: Record<string, string> = {};
    for (const f of fields) {
      const v = known[f.field as string];
      if (v != null && v !== "") prefill[f.field as string] = String(v);
    }
    setValues(prefill);
    setNote("");
    setMove({ card, to });
  };

  const commit = (card: KanbanCard, to: OrderStatus, captures: Partial<Order>, moveNote?: string) =>
    startTransition(async () => {
      const res = await advanceOrderStatus(card.so, to, captures, moveNote);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(`${card.so} → ${STATUS_LABEL[to]}`);
      setMove(null);
      router.refresh();
    });

  const submitDialog = () => {
    if (!move) return;
    const fields = REQUIRED_CAPTURES[move.to] ?? [];
    const captures: Record<string, unknown> = {};
    for (const f of fields) {
      const raw = values[f.field as string]?.trim();
      if (!raw) {
        if (!f.optional) {
          toast.error(`${f.label} is required`);
          return;
        }
        continue;
      }
      captures[f.field as string] = f.kind === "number" ? Number(raw) : raw;
    }
    commit(move.card, move.to, captures as Partial<Order>, note || undefined);
  };

  return (
    <>
      {/* Lanes are a horizontally scrolling row of FIXED-width columns. Forcing
          all seven into the viewport gave ~185px lanes at 1280px, which clipped
          lane titles, store names and the overdue tag; a comfortable lane that
          you scroll to is worth more than a cramped one you can see. Cards still
          scroll inside their lane and still page via LANE_PAGE. Empty lanes keep
          full width — the old rotated slim rail read as broken layout.
          Phone width stacks the lanes vertically. */}
      <div className="mb-4 flex flex-col gap-2.5 lg:h-[calc(100dvh-238px)] lg:snap-x lg:snap-proximity lg:flex-row lg:gap-3 lg:overflow-x-auto lg:overflow-y-hidden lg:pb-2">
        {LANES.map((lane) => {
          const v = WH_STATUS_VISUAL[lane];
          const list = byLane.get(lane)!;
          const shown = laneShown[lane] ?? LANE_PAGE;
          const visible = list.slice(0, shown);
          const hidden = list.length - visible.length;
          const empty = list.length === 0;
          return (
            <section
              key={lane}
              className="flex flex-col lg:h-full lg:w-[264px] lg:min-w-[264px] lg:flex-none lg:snap-start"
            >
              <header
                className="sticky top-0 z-10 mb-2.5 flex items-center gap-2 rounded-xl border-t-[3px] bg-card px-3 py-2.5 shadow-card"
                style={{ borderTopColor: v.rail }}
              >
                <Icon name={v.icon} size={15} className="shrink-0 text-ink-soft" />
                {/* No truncation: the lane is sized to its title, not the reverse. */}
                <span className="whitespace-nowrap text-[12.5px] font-bold">{STATUS_LABEL[lane]}</span>
                <span className="mono ml-auto shrink-0 rounded-md bg-paper px-1.5 py-0.5 font-display text-xs font-bold text-ink-soft">
                  {list.length}
                </span>
              </header>

              {empty ? (
                <div className="rounded-xl border border-dashed border-line-strong px-3 py-6 text-center text-[11.5px] text-mute lg:flex lg:min-h-0 lg:flex-1 lg:items-center lg:justify-center">
                  Nothing here
                </div>
              ) : (
                <div className="flex flex-col gap-2 lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:overflow-x-hidden lg:px-0.5">
                  {visible.map((c) => {
                    const nexts = WH_TRANSITIONS[c.status].filter((s) => WH_FLOW.includes(s) && WH_FLOW.indexOf(s) > WH_FLOW.indexOf(c.status));
                    const primaryNext = nexts[0];
                    const others = WH_TRANSITIONS[c.status].filter((s) => s !== primaryNext);
                    return (
                      <article
                        key={c.so}
                        className={cn(
                          // A left accent bar carries the due state instead of a
                          // pill on the header row — a pill had to share width
                          // with the order number and clipped to "hando overdu".
                          "group flex flex-col rounded-xl border-l-[3px] bg-card p-3 shadow-card transition-all hover:shadow-lift",
                          c.due === "overdue"
                            ? "border-l-breach"
                            : c.due === "today"
                              ? "border-l-sage"
                              : "border-l-transparent",
                        )}
                      >
                        {/* Order number owns its line. */}
                        <JourneyLink
                          so={c.so}
                          variant="text"
                          className="mono block font-display text-[13px] font-bold text-ink"
                        />
                        {c.due ? (
                          <span
                            className={cn(
                              "mt-1 self-start rounded-md px-1.5 py-0.5 text-[10px] font-bold",
                              c.due === "overdue" ? "bg-breach-bg text-breach" : "bg-sage-soft text-sage",
                            )}
                          >
                            {c.due === "overdue" ? "handover overdue" : "due today"}
                          </span>
                        ) : null}
                        {/* One clean truncation, full name on hover. */}
                        <div className="mt-1 truncate text-[13px] font-semibold text-ink" title={c.store}>
                          {c.store}
                        </div>
                        <div className="mt-0.5 text-[11.5px] text-mute">
                          {c.type} · {c.qty} pcs · {c.ageDays}d old
                          {c.priority ? " · HIGH" : ""}
                        </div>
                        {c.campaign ? (
                          <div className="mt-1.5 truncate rounded-md bg-paper px-2 py-1 text-[10.5px] font-medium text-ink-soft" title={c.campaign}>
                            {c.campaign}
                          </div>
                        ) : null}
                        {c.status === "RTS_LOGIC" && c.invoice ? (
                          <div className="mono mt-1.5 text-[10.5px] text-mute">Invoice {c.invoice}</div>
                        ) : null}
                        {canEdit && (primaryNext || others.length) ? (
                          // mt-auto pins the action to the bottom so cards in a
                          // lane share one rhythm even when the meta wraps.
                          <div className="mt-auto flex items-center gap-1.5 border-t border-line pt-2.5 [&:not(:first-child)]:mt-2.5">
                            {primaryNext ? (
                              <button
                                disabled={pending}
                                onClick={() => requestMove(c, primaryNext)}
                                className="flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-lg bg-ink px-2 py-1.5 text-[11.5px] font-semibold text-paper transition-colors hover:bg-sage disabled:opacity-50"
                              >
                                <span className="truncate">{STATUS_LABEL[primaryNext]}</span>
                                <Icon name="arrow-right-linear" size={13} className="shrink-0" />
                              </button>
                            ) : null}
                            {others.length ? (
                              <Dropdown>
                                <DropdownTrigger asChild>
                                  <button
                                    className="grid h-[26px] w-[26px] shrink-0 place-items-center rounded-lg border border-line-strong text-ink-soft hover:border-sage hover:text-sage"
                                    aria-label="More transitions"
                                  >
                                    <Icon name="menu-dots-bold" size={14} />
                                  </button>
                                </DropdownTrigger>
                                <DropdownContent align="end">
                                  {others.map((s) => (
                                    <DropdownItem key={s} onSelect={() => requestMove(c, s)}>
                                      <Icon name={WH_STATUS_VISUAL[s].icon} size={15} />
                                      {s === "ON_HOLD"
                                        ? "Put on hold"
                                        : s === "CANCELLED"
                                          ? "Cancel order"
                                          : s === "UNFULFILLABLE"
                                            ? "Mark unfulfillable"
                                            : `Back to ${STATUS_LABEL[s]}`}
                                    </DropdownItem>
                                  ))}
                                  <DropdownSeparator />
                                  <DropdownItem asChild>
                                    <Link href={`/orders/${c.so}`}>Open journey</Link>
                                  </DropdownItem>
                                </DropdownContent>
                              </Dropdown>
                            ) : null}
                          </div>
                        ) : null}
                      </article>
                    );
                  })}
                  {hidden > 0 ? (
                    <button
                      onClick={() => setLaneShown((s) => ({ ...s, [lane]: shown + LANE_PAGE * 2 }))}
                      className="rounded-xl border border-dashed border-line-strong px-3 py-2.5 text-xs font-semibold text-ink-soft transition-colors hover:border-sage hover:text-sage"
                    >
                      Show more — {hidden} hidden
                    </button>
                  ) : null}
                </div>
              )}
            </section>
          );
        })}
      </div>

      <div className="pb-8 text-[12.5px] text-mute">
        {terminalCount} cancelled / unfulfillable orders in this scope — see Reports for the full funnel.
      </div>

      <Dialog open={move !== null} onOpenChange={(o) => !o && setMove(null)}>
        {move ? (
          <DialogContent
            title={`${STATUS_LABEL[move.to]} · ${move.card.so}`}
            description={`${move.card.store} — capture the ${STATUS_LABEL[move.to].toLowerCase()} details. Logged as a manual change.`}
          >
            <div className="grid grid-cols-2 gap-3">
              {(REQUIRED_CAPTURES[move.to] ?? []).map((f) => (
                <div key={String(f.field)} className={f.kind === "partner" ? "col-span-2" : ""}>
                  <Field label={`${f.label}${f.optional ? " (optional)" : ""}`}>
                    {f.kind === "partner" ? (
                      <Select
                        value={values[f.field as string] ?? ""}
                        onChange={(e) => setValues((v) => ({ ...v, [f.field as string]: e.target.value }))}
                      >
                        <option value="">Select partner…</option>
                        {LOGISTICS_PARTNERS.map((p) => (
                          <option key={p} value={p}>
                            {p}
                          </option>
                        ))}
                      </Select>
                    ) : (
                      <Input
                        type={f.kind === "number" ? "number" : f.kind === "date" ? "date" : "text"}
                        value={values[f.field as string] ?? ""}
                        onChange={(e) => setValues((v) => ({ ...v, [f.field as string]: e.target.value }))}
                      />
                    )}
                  </Field>
                </div>
              ))}
              <div className="col-span-2">
                <Field label="Note (optional)">
                  <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Anything worth logging" />
                </Field>
              </div>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setMove(null)}>
                Cancel
              </Button>
              <Button onClick={submitDialog} disabled={pending}>
                {pending ? "Saving…" : `Move to ${STATUS_LABEL[move.to]}`}
              </Button>
            </div>
          </DialogContent>
        ) : null}
      </Dialog>
    </>
  );
}
