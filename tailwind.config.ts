import type { Config } from "tailwindcss";

// RetailJourney design tokens — the "Ledger" language.
//
// The status ramp is designed in OKLCH and converted to sRGB, which is the
// point: five of the seven tones share ONE foreground lightness (L 0.445) and
// one chroma (C ≈ 0.075). That shared lightness is what makes seven colours
// read as a single system rather than seven separate decisions — the specific
// failure of the previous ramp, whose foregrounds drifted across the set.
//
// Two exceptions earn their place:
//   pending  C 0.016 — "nothing to do yet" recedes into the cream
//   breach   L 0.435 / C 0.150 — ~1.8x the ramp's chroma, so a breach outranks
//            a pending by WEIGHT and not merely by hue
//
// Every foreground clears 4.5:1 on its own tint at 11px semibold (measured
// 6.26–6.82) and on all three surfaces. Both breach values sit just inside the
// sRGB gamut edge for their hue — nothing is silently clamped.
// Colour is never the only channel: status renders as icon + label always.

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  future: {
    // Wraps every `hover:` utility in `@media (hover: hover)`. This app runs on
    // floor tablets, where a tap leaves the hover style stuck on the control
    // until you touch something else — so a row you tapped stays highlighted
    // and reads as selected. One flag fixes it everywhere instead of gating
    // ~90 hover utilities by hand.
    hoverOnlyWhenSupported: true,
  },
  theme: {
    extend: {
      colors: {
        // Surfaces carry the same warm hue bias (H 85) as the ramp, so the
        // neutrals read as chosen rather than a generic grey on a cream ground.
        ground: "#F0ECE4",
        paper: "#F8F5F0",
        card: "#FDFCF9",
        ink: {
          DEFAULT: "#27221B", // 13.39:1 on ground
          soft: "#59534B", // 6.45:1 on ground
        },
        // Secondary text, not decoration: store meta, checkpoint cities, every
        // table header and KPI subtitle. Darkened until it clears 4.5:1 on the
        // DARKEST surface it ever sits on (ground) — 4.74 there, 5.14 on paper,
        // 5.44 on card. The first pass at this value measured 3.98 and failed.
        mute: "#6D6760",
        line: {
          // Decorative separators — deliberately near-invisible, no contrast
          // requirement because they never carry meaning on their own.
          DEFAULT: "#E7E2D9",
          strong: "#DCD7CC",
          // Control boundaries (input, select, chip) DO carry meaning: they say
          // "this is editable". WCAG 1.4.11 wants 3:1 against adjacent colour.
          // 3.15 on ground, 3.62 on card.
          control: "#89847C",
        },
        // Sage is CHROME ONLY — active nav, focus, selection, hover accent,
        // primary affordance. It never carries a status; that is the whole
        // reason the semantic ramp below exists. 6.67:1 on ground.
        sage: {
          DEFAULT: "#305A44",
          soft: "#E3F1E9",
          line: "#C8DCD0",
        },

        // ── Status ramp: hue answers "where is the baton", nothing else ──
        // Foreground / tint ratios, measured: see the header comment.

        // In courier motion, and only that.
        transit: {
          DEFAULT: "#2B577F", // 6.45:1 on its tint
          bg: "#E3EEFA",
        },
        // Needs hands now: PICKING, PACKING, OUT_FOR_DELIVERY, and a store
        // receipt still waiting to be inwarded.
        ofd: {
          DEFAULT: "#74481E", // 6.63:1
          bg: "#F8EADE",
        },
        // Staged — the warehouse is done and the baton is waiting to be taken.
        stage: {
          DEFAULT: "#1D6054", // 6.30:1
          bg: "#E0F1ED",
        },
        // Arrived and finished: DELIVERED, INWARDED, CLOSED, WITHIN_SLA.
        deliv: {
          DEFAULT: "#33603B", // 6.26:1
          bg: "#E4F1E5",
        },
        // Failed or overdue. Never used for a mere coverage gap. The one tone
        // that breaks the ramp's uniformity, deliberately — see header.
        breach: {
          DEFAULT: "#922119", // 6.82:1
          bg: "#FDDFDA",
        },
        // Waiting, nothing to do yet. Chroma pulled almost to zero so it
        // recedes into the cream instead of competing with real work.
        pending: {
          DEFAULT: "#59534A", // 6.51:1
          bg: "#F0EDE8",
        },
        // Deliberately paused by a human.
        hold: {
          DEFAULT: "#5A4B75", // 6.60:1
          bg: "#EFEAF9",
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
        // The missing tier. Every section heading in the app was `text-ui
        // font-bold` — 13px body text doing an h2's job — so the display face
        // jumped from the 27-32px h1 straight to nothing. Tracking is negative
        // because tracking is size-specific: letters read too far apart as they
        // grow, and a single letter-spacing value is wrong somewhere.
        sec: ["19px", { lineHeight: "1.2", letterSpacing: "-0.015em" }],
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
          from: { backgroundColor: "rgba(43,87,127,.13)", boxShadow: "inset 3px 0 0 0 #2B577F" },
          to: { backgroundColor: "transparent", boxShadow: "inset 3px 0 0 0 transparent" },
        },
        // An order CROSSING INTO BREACH. Distinct from `arrive` because it is
        // the single most consequential state change in the product and it was
        // silent: `breaching` was not part of the board's change signature, so
        // nothing fired — while the row simultaneously re-sorted to the top of
        // the board (breaches sort first) with nothing bridging the jump.
        // Breach-keyed, and background/box-shadow only like its sibling: no
        // transform, so a row the user is reaching for never moves.
        breachArrive: {
          from: { backgroundColor: "rgba(146,33,25,.16)", boxShadow: "inset 3px 0 0 0 #922119" },
          to: { backgroundColor: "transparent", boxShadow: "inset 3px 0 0 0 transparent" },
        },
        // The mobile drawer, now a Radix Dialog so it has a real exit. Enter
        // and exit travel the SAME edge — a panel that slides in from the left
        // and vanishes in place reads as two unrelated events.
        drawerIn: {
          from: { transform: "translateX(-100%)" },
          to: { transform: "translateX(0)" },
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
        breachArrive: "breachArrive 1.6s ease-out both",
        // Deliberate open, faster close: the open is a decision the user made
        // and watches, the close is the system getting out of the way.
        drawerIn: "drawerIn .26s cubic-bezier(.32,.72,0,1)",
        drawerOut: "drawerIn .18s cubic-bezier(.32,.72,0,1) reverse",
        shimmer: "shimmer 1.4s linear infinite",
      },
      transitionTimingFunction: {
        // The house curve. Every press, hover and colour change in the product
        // uses this one so motion reads as a single hand.
        ui: "cubic-bezier(.2,.7,.3,1)",
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
