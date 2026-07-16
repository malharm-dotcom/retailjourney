"use client";

// Radix dialog re-themed to RetailJourney tokens (shadcn-style base, PRD §9).

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { cn } from "@/lib/ui";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export function DialogContent({
  className,
  children,
  title,
  description,
  ...props
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
  title: string;
  description?: string;
}) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-ink/30 backdrop-blur-[2px] data-[state=open]:animate-rise" />
      {/* Centered via inset-0 + m-auto (not transforms): the `rise` keyframe ends
          at `transform: none` with fill both, which would permanently override a
          translate(-50%,-50%) and anchor the dialog bottom-right. */}
      <DialogPrimitive.Content
        className={cn(
          "fixed inset-0 z-50 m-auto h-fit max-h-[85dvh] w-[min(94vw,480px)] overflow-y-auto rounded-2xl bg-card p-6 shadow-pop outline-none data-[state=open]:animate-rise",
          className,
        )}
        {...props}
      >
        <DialogPrimitive.Title className="font-display text-lg font-bold tracking-tight">
          {title}
        </DialogPrimitive.Title>
        {description ? (
          <DialogPrimitive.Description className="mt-1 text-[13px] text-mute">
            {description}
          </DialogPrimitive.Description>
        ) : null}
        <div className="mt-4">{children}</div>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
