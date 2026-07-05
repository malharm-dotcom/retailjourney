// Solar duotone icons rendered inline from a generated subset (see
// scripts/gen-icons.mjs) — no CDN, no icon-font, ~10 KB instead of the full
// collection. Usage: <Icon name="delivery-bold-duotone" />

import type { IconifyJSON } from "@iconify/types";
import solar from "@/generated/icons.json";
import { getIconData, iconToSVG, replaceIDs } from "@iconify/utils";

let uid = 0;

export function Icon({
  name,
  size = 16,
  className,
}: {
  name: string;
  size?: number;
  className?: string;
}) {
  const data = getIconData(solar as IconifyJSON, name);
  if (!data) return null;
  const svg = iconToSVG(data, { height: size, width: size });
  uid += 1;
  return (
    <svg
      {...svg.attributes}
      className={className}
      aria-hidden
      style={{ display: "inline-block", verticalAlign: "-0.15em" }}
      dangerouslySetInnerHTML={{ __html: replaceIDs(svg.body, `relay-${uid}-`) }}
    />
  );
}
