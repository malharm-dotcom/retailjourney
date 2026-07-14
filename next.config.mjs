/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    // Enables src/instrumentation.ts — the in-app sync scheduler (M2).
    instrumentationHook: true,
    // snowflake-sdk ships native/dynamic internals webpack must not bundle.
    serverComponentsExternalPackages: ["snowflake-sdk"],
  },
};

export default nextConfig;
