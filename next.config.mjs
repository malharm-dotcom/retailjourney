/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    // Enables src/instrumentation.ts — the in-app sync scheduler (M2).
    instrumentationHook: true,
  },
};

export default nextConfig;
