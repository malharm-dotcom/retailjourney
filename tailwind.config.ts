import type { Config } from "tailwindcss";

// RetailJourney design tokens — derived 1:1 from the approved prototype
// (retailjourney-in-transit-v2.html). Cream ground, near-black ink, sage accent,
// semantic status colours always paired with icon + label, never colour alone.

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ground: "#F1EEE6",
        paper: "#FBF9F4",
        card: "#FFFFFF",
        ink: {
          DEFAULT: "#232019",
          soft: "#5C5648",
        },
        // Secondary text, not decoration: it carries store meta, checkpoint
        // cities, every table header and every KPI subtitle. The prototype's
        // #968E7E read at 2.80:1 on the cream ground — below AA at any size, on
        // a shared floor terminal. Darkened until it clears 4.5:1 on the
        // DARKEST surface it ever sits on (ground), which puts it at 4.70 there,
        // 5.18 on paper and 5.45 on card.
        mute: "#6F695D",
        line: {
          // Decorative separators — deliberately near-invisible, no contrast
          // requirement because they never carry meaning on their own.
          DEFAULT: "#EBE5D8",
          strong: "#E0D8C8",
          // Control boundaries (input, select, chip) DO carry meaning: they say
          // "this is editable". WCAG 1.4.11 wants 3:1 against adjacent colour,
          // and `strong` managed 1.22 on ground. 3.08 / 3.40 / 3.57 on
          // ground / paper / card.
          control: "#8C877D",
        },
        // Sage is CHROME ONLY — active nav, focus, selection, hover accent,
        // primary affordance. It used to also mean READY_TO_DISPATCH, RTS_LOGIC,
        // INWARDED and the Pickup-Pending KPI, which is why colour could never
        // carry status by itself. Statuses use the semantic ramp below.
        sage: {
          DEFAULT: "#3E5D4C",
          soft: "#E8EEE9",
          line: "#CBD8CF",
        },

        // ── Status ramp: hue answers "where is the baton", nothing else ──
        // Every foreground below clears 4.5:1 on its own tint at 11px semibold
        // (measured 5.00–5.06); the tints themselves are unchanged from the
        // approved prototype, so the cream world is intact.

        // In courier motion, and only that. Previously also meant PICKING,
        // RECEIVED and DISPATCHED — four meanings, so blue meant "somewhere in
        // the middle" rather than anything.
        transit: {
          DEFAULT: "#416984",
          bg: "#E7EFF4",
        },
        // Needs hands now: PICKING, PACKING, OUT_FOR_DELIVERY, and a store
        // receipt still waiting to be inwarded.
        ofd: {
          DEFAULT: "#855C21",
          bg: "#F5ECD9",
        },
        // Staged — the warehouse is done and the baton is waiting to be taken.
        // New token: these states used to borrow sage and read as chrome.
        stage: {
          DEFAULT: "#2A6F67",
          bg: "#E4F0EE",
        },
        // Arrived and finished: DELIVERED, INWARDED, CLOSED, WITHIN_SLA.
        deliv: {
          DEFAULT: "#396F54",
          bg: "#E6F0EA",
        },
        // Failed or overdue. Never used for a mere coverage gap.
        breach: {
          DEFAULT: "#A34737",
          bg: "#F6E8E3",
        },
        // Waiting, nothing to do yet. `DEFAULT` is a rail colour only; pending
        // pills use ink-soft on the tint (4.54:1), never this on that.
        pending: {
          DEFAULT: "#9A9080",
          bg: "#EEEAE0",
        },
        // Deliberately paused by a human.
        hold: {
          DEFAULT: "#705A88",
          bg: "#EFEAF4",
        },
      },
      fontFamily: {
        display: ["var(--font-bricolage)", "system-ui", "sans-serif"],
        sans: ["var(--font-hanken)", "system-ui", "sans-serif"],
      },
      boxShadow: {
        card: "0 1px 2px rgba(35,32,25,.04), 0 10px 30px rgba(35,32,25,.05)",
        lift: "0 2px 6px rgba(35,32,25,.06), 0 16px 40px rgba(35,32,25,.09)",
        pop: "0 4px 12px rgba(35,32,25,.10), 0 24px 60px rgba(35,32,25,.14)",
      },
      // A named type scale. The codebase had grown to fourteen sizes, several
      // separated by half a pixel (11 / 11.5 / 12 / 12.5 / 13 / 13.5), which is
      // drift rather than hierarchy — no reader distinguishes 12 from 12.5.
      // These seven steps cover every real role; `display` sizes stay inline on
      // the h1 because they are the only fluid pair.
      fontSize: {
        meta: ["10px", { lineHeight: "1.4" }], // source badges, micro-flags
        cap: ["11.5px", { lineHeight: "1.45" }], // table headers, meta lines, captions
        dense: ["12.5px", { lineHeight: "1.5" }], // dense table cells, footnotes
        ui: ["13px", { lineHeight: "1.5" }], // default UI body, controls, labels
        row: ["14px", { lineHeight: "1.45" }], // primary value in a row
        title: ["15.5px", { lineHeight: "1.3" }], // card and panel titles
        num: ["19px", { lineHeight: "1.1" }], // the big tabular figure
      },
      borderRadius: {
        // Two radii for two jobs: containers and controls. Pills stay
        // `rounded-full` and remain for small controls only.
        card: "16px",
        control: "10px",
      },
      keyframes: {
        rise: {
          from: { opacity: "0", transform: "translateY(6px)" },
          to: { opacity: "1", transform: "none" },
        },
        fade: {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
        dialogIn: {
          from: { opacity: "0", transform: "translateY(6px) scale(.985)" },
          to: { opacity: "1", transform: "none" },
        },
        slideIn: {
          from: { transform: "translateX(-100%)" },
          to: { transform: "translateX(0)" },
        },
        // A value the 15-minute poller just changed under the user's eyes. The
        // row was already on screen, so this is not an entrance — it is a
        // "look here, this moved" wash that decays to nothing. Background and
        // box-shadow only: no transform, so it never nudges a row the user is
        // about to click.
        arrive: {
          from: { backgroundColor: "rgba(65,105,132,.14)", boxShadow: "inset 3px 0 0 0 #416984" },
          to: { backgroundColor: "transparent", boxShadow: "inset 3px 0 0 0 transparent" },
        },
        // The baton pass. A completed leg's connector draws left-to-right, so
        // the journey reads as a hand-off in the direction the work travels
        // rather than four dots that were always lit. scaleX from a
        // left origin — no layout, no paint of the track itself.
        batonDraw: {
          from: { transform: "scaleX(0)" },
          to: { transform: "scaleX(1)" },
        },
        // A stage node landing as its leg completes.
        stageIn: {
          from: { transform: "scale(.82)", opacity: "0" },
          "70%": { transform: "scale(1.04)", opacity: "1" },
          to: { transform: "scale(1)", opacity: "1" },
        },
        // A card leaving its old lane after an optimistic advance. The
        // counterpart to cardLand: previously the card vanished instantly from
        // the source lane and only announced itself on arrival, so the eye had
        // nothing to follow across the board.
        cardLeave: {
          from: { opacity: "1", transform: "none" },
          to: { opacity: "0", transform: "translateY(-6px) scale(.97)" },
        },
        // A card arriving in its new lane after an optimistic advance: it
        // settles in and a sage ring fades out, so the eye can follow where
        // the work went instead of the board silently reshuffling.
        cardLand: {
          from: { opacity: "0", transform: "translateY(-8px)", boxShadow: "0 0 0 2px rgba(62,122,92,.55)" },
          "60%": { opacity: "1", transform: "none", boxShadow: "0 0 0 2px rgba(62,122,92,.35)" },
          to: { boxShadow: "0 0 0 0 rgba(62,122,92,0)" },
        },
        shimmer: {
          from: { backgroundPosition: "200% 0" },
          to: { backgroundPosition: "-200% 0" },
        },
      },
      animation: {
        // Routine feedback stays 150–250ms. Nothing bouncy, nothing decorative,
        // and no entrance choreography an operator has to sit through: this is a
        // tool people use for eight hours, so motion only ever explains a change
        // they did not already see happen.
        rise: "rise .22s cubic-bezier(.2,.7,.3,1) both",
        fade: "fade .18s ease-out both",
        dialogIn: "dialogIn .2s cubic-bezier(.2,.7,.3,1)",
        overlayIn: "fade .16s ease-out",
        slideIn: "slideIn .2s cubic-bezier(.2,.7,.3,1)",
        cardLand: "cardLand .42s cubic-bezier(.2,.7,.3,1) both",
        cardLeave: "cardLeave .16s ease-in both", // exits faster than it arrives
        // The one authored moment in the product, and the only thing over 500ms.
        batonDraw: "batonDraw .5s cubic-bezier(.16,1,.3,1) both",
        stageIn: "stageIn .34s cubic-bezier(.16,1,.3,1) both",
        arrive: "arrive 1.6s ease-out both",
        shimmer: "shimmer 1.4s linear infinite",
      },
      maxWidth: {
        // The single content measure. AppShell owns it; the old 1220px `.wrap`
        // was a second, competing width with no remaining consumers.
        shell: "1360px",
      },
    },
  },
  plugins: [],
};

export default config;
