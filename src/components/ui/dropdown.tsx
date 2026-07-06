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
          "z-50 min-w-[220px] rounded-xl border border-line bg-card p-1.5 shadow-pop data-[state=open]:animate-rise",
          className,
        )}
        {...props}
      />
    </DropdownPrimitive.Portal>
  );
}

export function DropdownItem({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof DropdownPrimitive.Item>) {
  return (
    <DropdownPrimitive.Item
      className={cn(
        "flex cursor-pointer select-none items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] font-medium text-ink-soft outline-none data-[highlighted]:bg-sage-soft data-[highlighted]:text-sage",
        className,
      )}
      {...props}
    />
  );
}
