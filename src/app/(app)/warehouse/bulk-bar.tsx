"use client";

// The sticky bulk-action bar and its shared-capture dialog.
//
// The dialog is the headline: one truck, one consignment, five fields entered
// ONCE and applied to every selected order. That is the Sheets-parity win —
// the floor used to type the same LR and vehicle number into forty rows.

import { useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Icon } from "@/components/icon";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button, Field, Input, Select } from "@/components/ui/primitives";
import { REQUIRED_CAPTURES, STATUS_LABEL, WH_FLOW } from "@/lib/journey";
import { LOGISTICS_PARTNERS, type Order, type OrderStatus } from "@/lib/types";

/** Forward targets reachable from at least one selected card, with how many can
 *  actually make the move. Offering a target that only some can reach is fine —
 *  the server reports the rest as skips — but the count has to say so up front. */
export function eligibleTargets(statuses: OrderStatus[]): { to: OrderStatus; count: number }[] {
  const out: { to: OrderStatus; count: number }[] = [];
  for (let i = 1; i < WH_FLOW.length; i++) {
    const to = WH_FLOW[i];
    const count = statuses.filter((s) => {
      const here = WH_FLOW.indexOf(s);
      return here >= 0 && i > here;
    }).length;
    if (count > 0) out.push({ to, count });
  }
  return out;
}

export function BulkBar({
  count,
  statuses,
  pending,
  onClear,
  onAdvance,
}: {
  count: number;
  statuses: OrderStatus[];
  pending: boolean;
  onClear: () => void;
  onAdvance: (to: OrderStatus, captures?: Partial<Order>) => void;
}) {
  const reduce = useReducedMotion();
  const [dispatching, setDispatching] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  const targets = eligibleTargets(statuses);
  const DISPATCH: OrderStatus = "DISPATCHED_TO_STORE";
  const dispatchable = targets.find((t) => t.to === DISPATCH);
  // Everything except dispatch moves without extra input. RTS_LOGIC is in here
  // deliberately: its four captures (box count, weight, invoice, RTS date)
  // describe one order each, so there is no shared value to type once — orders
  // that already carry them advance, the rest come back as skips.
  const captureless = targets.filter((t) => t.to !== DISPATCH);

  const submitDispatch = () => {
    const fields = REQUIRED_CAPTURES[DISPATCH] ?? [];
    const captures: Record<string, unknown> = {};
    const bad: Record<string, string> = {};
    for (const f of fields) {
      const raw = values[f.field as string]?.trim();
      if (!raw) {
        if (!f.optional) bad[f.field as string] = "Required";
        continue;
      }
      captures[f.field as string] = f.kind === "number" ? Number(raw) : raw;
    }
    setErrors(bad);
    if (Object.keys(bad).length > 0) return;
    onAdvance(DISPATCH, captures as Partial<Order>);
    setDispatching(false);
    setValues({});
  };

  return (
    <>
      <AnimatePresence>
        {count > 0 ? (
          <motion.div
            initial={reduce ? { opacity: 0 } : { y: 24, opacity: 0 }}
            animate={reduce ? { opacity: 1 } : { y: 0, opacity: 1 }}
            exit={reduce ? { opacity: 0 } : { y: 24, opacity: 0 }}
            transition={reduce ? { duration: 0.12 } : { type: "spring", stiffness: 420, damping: 32 }}
            className="fixed inset-x-0 bottom-0 z-30 flex justify-center px-4 pb-4"
            role="region"
            aria-label="Bulk actions"
          >
            <div className="flex max-w-full flex-wrap items-center gap-2.5 rounded-control border border-line-control bg-card px-4 py-3 shadow-lift">
              <span className="flex items-center gap-2 text-ui font-bold">
                <span className="mono grid h-7 min-w-7 place-items-center rounded-md bg-ink px-1.5 text-cap text-paper">
                  {count}
                </span>
                selected
              </span>

              <span className="mx-1 hidden h-5 w-px bg-line sm:block" />

              {captureless.map((t) => (
                <Button key={t.to} variant="outline" disabled={pending} onClick={() => onAdvance(t.to)}>
                  <Icon name="arrow-right-linear" size={14} />
                  {STATUS_LABEL[t.to]}
                  {t.count < count ? <span className="text-cap text-mute">({t.count})</span> : null}
                </Button>
              ))}

              {dispatchable ? (
                <Button disabled={pending} onClick={() => (setErrors({}), setDispatching(true))}>
                  <Icon name="box-bold-duotone" size={15} />
                  Dispatch selected…
                  {dispatchable.count < count ? (
                    <span className="text-cap opacity-70">({dispatchable.count})</span>
                  ) : null}
                </Button>
              ) : null}

              <Button variant="ghost" onClick={onClear} disabled={pending}>
                Clear
              </Button>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <Dialog open={dispatching} onOpenChange={(o) => !o && setDispatching(false)}>
        {dispatching ? (
          <DialogContent
            title={`Dispatch ${dispatchable?.count ?? 0} order${(dispatchable?.count ?? 0) === 1 ? "" : "s"}`}
            description="One truck, one consignment — these details are entered once and applied to every selected order. Orders not yet at the dispatch step are skipped and reported back."
          >
            <form
              onSubmit={(e) => {
                e.preventDefault();
                submitDispatch();
              }}
            >
              <div className="grid grid-cols-2 gap-3">
                {(REQUIRED_CAPTURES[DISPATCH] ?? []).map((f) => {
                  const key = f.field as string;
                  const err = errors[key];
                  return (
                    <div key={key} className={f.kind === "partner" ? "col-span-2" : ""}>
                      <Field label={`${f.label}${f.optional ? " (optional)" : ""}`} error={err}>
                        {f.kind === "partner" ? (
                          <Select
                            invalid={Boolean(err)}
                            value={values[key] ?? ""}
                            onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
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
                            invalid={Boolean(err)}
                            type={f.kind === "number" ? "number" : f.kind === "date" ? "date" : "text"}
                            value={values[key] ?? ""}
                            onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
                          />
                        )}
                      </Field>
                    </div>
                  );
                })}
              </div>
              <div className="mt-4 flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setDispatching(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={pending}>
                  {pending ? "Dispatching…" : `Dispatch ${dispatchable?.count ?? 0}`}
                </Button>
              </div>
            </form>
          </DialogContent>
        ) : null}
      </Dialog>
    </>
  );
}
