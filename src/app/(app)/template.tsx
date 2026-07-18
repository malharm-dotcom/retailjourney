// A template (not a layout) re-mounts on every route change, so this gives each
// screen switch a subtle, fast fade-in. Purely visual; honours reduced-motion
// via the global override in globals.css.
export default function AppTemplate({ children }: { children: React.ReactNode }) {
  return <div className="animate-fade">{children}</div>;
}
