"use client";

// Small shared primitives, re-themed to the RetailJourney tokens (shadcn-style base).

import * as React from "react";
import { TONE, cn, type Tone } from "@/lib/ui";

export const Button = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" | "outline" | "danger" }
>(function Button({ className, variant = "primary", type = "button", ...props }, ref) {
  return (
    <button
      ref={ref}
      // Defaults to `button`. A bare <button> inside a form submits it, which is
      // exactly the accident we do not want on a Cancel beside a destructive
      // confirm — submitting is opted into, never inherited.
      type={type}
      className={cn(
        // Press feedback. There was none anywhere in the product — not one
        // `active:` state — and this runs on tablets where hover does not
        // exist, so a supervisor doing 200 transitions a shift got no
        // confirmation the tap registered until the server came back. The
        // scale is deliberately small: at tens-of-times-a-day frequency,
        // motion should be felt rather than watched.
        "inline-flex min-h-[38px] items-center justify-center gap-2 rounded-control px-4 py-2 text-ui font-semibold",
        "transition-[transform,background-color,border-color,color] duration-150 ease-ui",
        "active:scale-[0.97] disabled:pointer-events-none disabled:opacity-45",
        variant === "primary" && "bg-ink text-paper hover:bg-ink/85",
        variant === "ghost" && "text-ink-soft hover:bg-line/60",
        variant === "outline" &&
          "border border-line-control bg-paper text-ink-soft hover:border-sage hover:bg-sage-soft hover:text-sage",
        variant === "danger" && "bg-breach text-white hover:bg-breach/85",
        className,
      )}
      {...props}
    />
  );
});

export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }
>(function Input({ className, invalid, ...props }, ref) {
  return (
    <input
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cn(
        "w-full rounded-control border bg-paper px-3 py-2 text-ui text-ink outline-none transition-colors duration-150 ease-ui placeholder:text-mute focus:border-sage",
        // line-control clears 3:1 against the field fill and the page, so the
        // boundary that says "this is editable" is actually visible. `line-strong`
        // managed 1.22:1 on the cream ground.
        invalid ? "border-breach bg-breach-bg/40" : "border-line-control",
        className,
      )}
      {...props}
    />
  );
});

export const Select = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }
>(function Select({ className, invalid, ...props }, ref) {
  return (
    <select
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cn(
        "w-full rounded-control border bg-paper px-3 py-2 text-ui text-ink outline-none transition-colors duration-150 ease-ui focus:border-sage",
        invalid ? "border-breach bg-breach-bg/40" : "border-line-control",
        className,
      )}
      {...props}
    />
  );
});

/**
 * Labelled form row. `error` renders beside the field it belongs to rather than
 * in a corner toast — a validation message 700px from the input that failed is
 * not a message, it is a notification about a message.
 */
export function Field({
  label,
  error,
  hint,
  children,
}: {
  label: string;
  error?: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-cap font-semibold uppercase tracking-[0.04em] text-mute">{label}</span>
      {children}
      {error ? (
        <span className="mt-1 flex items-center gap-1 text-cap font-semibold text-breach">{error}</span>
      ) : hint ? (
        <span className="mt-1 block text-cap text-mute">{hint}</span>
      ) : null}
    </label>
  );
}

/**
 * Filter chip (the prototype's .chip).
 *
 * `aria-pressed` is the point: the active state used to be carried purely by
 * `bg-ink text-white`, so a screen-reader user had no way to know which filter
 * was on across the eleven chips in the app. `tone` draws the dot from the
 * status ramp so a chip's colour and its rows' colour cannot drift apart.
 */
export function Chip({
  active,
  tone,
  className,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean; tone?: Tone }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      className={cn(
        "flex min-h-[38px] items-center gap-2 rounded-full border px-3.5 py-2 text-ui font-medium",
        "transition-[transform,background-color,border-color,color] duration-150 ease-ui active:scale-[0.97]",
        active ? "border-ink bg-ink text-white" : "border-line-control bg-paper text-ink-soft hover:border-ink-soft",
        className,
      )}
      {...props}
    >
      {tone ? (
        <span
          aria-hidden
          className="h-2 w-2 shrink-0 rounded-full ring-1 ring-inset ring-black/10"
          style={{ background: TONE[tone].hex }}
        />
      ) : null}
      {children}
    </button>
  );
}
