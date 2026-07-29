import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex min-h-[70vh] flex-col items-center justify-center gap-4 text-center">
      <div className="font-display text-[64px] font-extrabold leading-none tracking-tight text-ink">
        404
      </div>
      <p className="max-w-sm text-sm text-mute">
        That page isn&rsquo;t on the track. Head back to the Control Tower.
      </p>
      <Link
        href="/"
        className="flex min-h-[38px] items-center rounded-control bg-ink px-4 py-2.5 text-ui font-semibold text-paper transition-colors duration-150 ease-ui hover:bg-ink/85"
      >
        Back to Control Tower
      </Link>
    </div>
  );
}
