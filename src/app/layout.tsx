import type { Metadata } from "next";
import { Bricolage_Grotesque, Hanken_Grotesk } from "next/font/google";
import { Toaster } from "sonner";
import "./globals.css";

const bricolage = Bricolage_Grotesque({
  subsets: ["latin"],
  variable: "--font-bricolage",
  weight: ["500", "600", "700", "800"],
});

const hanken = Hanken_Grotesk({
  subsets: ["latin"],
  variable: "--font-hanken",
  weight: ["400", "500", "600", "700"],
});

export const metadata: Metadata = {
  title: { default: "RetailJourney — Snitch B2B Distribution", template: "%s · RetailJourney" },
  description:
    "The baton passing cleanly between Merchandising, Warehouse, Logistics and Store.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${bricolage.variable} ${hanken.variable}`}>
      <head>
        {/*
          Stamps the saved nav state before first paint.

          It has to run here, synchronously in <head>, rather than in an effect:
          the rail's width is CSS driven off this attribute, and a React effect
          would paint the 216px rail first and collapse it a frame later — on
          every navigation, for every user who chose the narrow rail.

          Wrapped in try/catch because reading localStorage throws outright
          under some privacy settings, and a thrown module-level script would
          take the whole document with it. Failing quiet means the rail renders
          expanded, which is the default anyway.

          Keep the key in step with NAV_STORAGE_KEY in components/shell/sidebar.
        */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{document.documentElement.dataset.nav=localStorage.getItem("retailjourney-nav")==="collapsed"?"collapsed":"expanded"}catch(e){}`,
          }}
        />
      </head>
      <body>
        {children}
        <Toaster
          position="bottom-right"
          toastOptions={{
            style: {
              background: "#232019",
              color: "#FBF9F4",
              border: "none",
              fontFamily: "var(--font-hanken)",
            },
          }}
        />
      </body>
    </html>
  );
}
