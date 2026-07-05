import type { Config } from "tailwindcss";

// Relay design tokens — derived 1:1 from the approved prototype
// (relay-in-transit-v2.html). Cream ground, near-black ink, sage accent,
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
        mute: "#968E7E",
        line: {
          DEFAULT: "#EBE5D8",
          strong: "#E0D8C8",
        },
        sage: {
          DEFAULT: "#3E5D4C",
          soft: "#E8EEE9",
          line: "#CBD8CF",
        },
        transit: {
          DEFAULT: "#4C7A99",
          bg: "#E7EFF4",
        },
        ofd: {
          DEFAULT: "#B67F2E",
          bg: "#F5ECD9",
        },
        deliv: {
          DEFAULT: "#3E7A5C",
          bg: "#E6F0EA",
        },
        breach: {
          DEFAULT: "#BE5340",
          bg: "#F6E8E3",
        },
        pending: {
          DEFAULT: "#9A9080",
          bg: "#EEEAE0",
        },
        hold: {
          DEFAULT: "#8A6FA8",
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
      borderRadius: {
        xl2: "18px",
      },
      keyframes: {
        rise: {
          from: { opacity: "0", transform: "translateY(8px)" },
          to: { opacity: "1", transform: "none" },
        },
        pulse2: {
          "0%": { boxShadow: "0 0 0 0 rgba(62,122,92,.4)" },
          "70%": { boxShadow: "0 0 0 8px rgba(62,122,92,0)" },
          "100%": { boxShadow: "0 0 0 0 rgba(62,122,92,0)" },
        },
      },
      animation: {
        rise: "rise .5s cubic-bezier(.2,.7,.3,1) both",
        pulse2: "pulse2 2.2s infinite",
      },
      maxWidth: {
        wrap: "1220px",
      },
    },
  },
  plugins: [],
};

export default config;
