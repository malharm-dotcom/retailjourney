import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex min-h-[70vh] flex-col items-center justify-center gap-4 text-center">
      <div className="font-display text-[64px] font-extrabold leading-none tracking-tight">
        4<span className="text-sage">#</span>4
      </div>
      <p className="max-w-sm text-sm text-mute">
        That record isn&rsquo;t on the track. Check the SO number, or head back to the board.
      </p>
      <Link
        href="/"
        className="rounded-[10px] bg-ink px-4 py-2.5 text-[13px] font-semibold text-paper transition-colors hover:bg-ink/85"
      >
        Back to Control Tower
      </Link>
    </div>
  );
}
