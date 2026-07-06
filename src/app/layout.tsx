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
