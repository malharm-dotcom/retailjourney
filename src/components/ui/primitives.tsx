"use client";

// Small shared primitives, re-themed to the RetailJourney tokens (shadcn-style base).

import * as React from "react";
import { cn } from "@/lib/ui";

export const Button = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" | "outline" | "danger" }
>(function Button({ className, variant = "primary", ...props }, ref) {
  return (
    <button
      ref={ref}
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-[10px] px-4 py-2 text-[13px] font-semibold transition-all disabled:pointer-events-none disabled:opacity-45",
        variant === "primary" && "bg-ink text-paper hover:bg-ink/85",
        variant === "ghost" && "text-ink-soft hover:bg-line/60",
        variant === "outline" &&
          "border border-line-strong bg-paper text-ink-soft hover:border-sage hover:bg-sage-soft hover:text-sage",
        variant === "danger" && "bg-breach text-white hover:bg-breach/85",
        className,
      )}
      {...props}
    />
  );
});

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    return (
      <input
        ref={ref}
        className={cn(
          "w-full rounded-[10px] border border-line-strong bg-paper px-3 py-2 text-[13px] text-ink outline-none transition-colors placeholder:text-mute focus:border-sage",
          className,
        )}
        {...props}
      />
    );
  },
);

export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, ...props }, ref) {
    return (
      <select
        ref={ref}
        className={cn(
          "w-full rounded-[10px] border border-line-strong bg-paper px-3 py-2 text-[13px] text-ink outline-none transition-colors focus:border-sage",
          className,
        )}
        {...props}
      />
    );
  },
);

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[11.5px] font-semibold uppercase tracking-[0.04em] text-mute">
        {label}
      </span>
      {children}
    </label>
  );
}

/** Filter chip (the prototype's .chip). */
export function Chip({
  active,
  dot,
  className,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean; dot?: string }) {
  return (
    <button
      className={cn(
        "flex items-center gap-2 rounded-full border px-3.5 py-2 text-[13px] font-medium transition-all",
        active
          ? "border-ink bg-ink text-white"
          : "border-line-strong bg-paper text-ink-soft hover:border-ink-soft",
        className,
      )}
      {...props}
    >
      {dot ? <span className="h-2 w-2 rounded-full" style={{ background: dot }} /> : null}
      {children}
    </button>
  );
}
