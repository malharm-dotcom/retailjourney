"use client";

// Radix dropdown re-themed to RetailJourney tokens.

import * as React from "react";
import * as DropdownPrimitive from "@radix-ui/react-dropdown-menu";
import { cn } from "@/lib/ui";

export const Dropdown = DropdownPrimitive.Root;
export const DropdownTrigger = DropdownPrimitive.Trigger;
export const DropdownLabel = DropdownPrimitive.Label;
export const DropdownSeparator = function Separator({ className }: { className?: string }) {
  return <DropdownPrimitive.Separator className={cn("my-1 h-px bg-line", className)} />;
};

export function DropdownContent({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof DropdownPrimitive.Content>) {
  return (
    <DropdownPrimitive.Portal>
      <DropdownPrimitive.Content
        sideOffset={8}
        collisionPadding={12}
        className={cn(
          "z-50 min-w-[220px] rounded-control bg-card p-1.5 shadow-pop data-[state=open]:animate-rise",
          className,
        )}
        {...props}
      />
    </DropdownPrimitive.Portal>
  );
}

export function DropdownItem({
  className,
  destructive,
  ...props
}: React.ComponentPropsWithoutRef<typeof DropdownPrimitive.Item> & {
  /** Ends or destroys something. Reads red at rest, not only on hover, so it is
   *  distinguishable before the pointer arrives — and by shape as much as hue. */
  destructive?: boolean;
}) {
  return (
    <DropdownPrimitive.Item
      className={cn(
        "flex min-h-[38px] cursor-pointer select-none items-center gap-2.5 rounded-control px-3 py-2 text-ui font-medium outline-none",
        destructive
          ? "text-breach data-[highlighted]:bg-breach-bg data-[highlighted]:text-breach"
          : "text-ink-soft data-[highlighted]:bg-sage-soft data-[highlighted]:text-sage",
        className,
      )}
      {...props}
    />
  );
}
