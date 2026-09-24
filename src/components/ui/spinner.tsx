import { cn } from "@/lib/ui";

/** A small ring spinner. Under reduced motion the global rule stills it, and
 *  the "Loading" text beside every use carries the meaning on its own. */
export function Spinner({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("inline-block shrink-0 animate-spin rounded-full border-2 border-current border-r-transparent", className)}
      style={{ width: size, height: size }}
    />
  );
}
