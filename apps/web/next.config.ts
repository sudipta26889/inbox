// ANALYTICS/MONITORING DISABLED FOR PRIVACY
// import { withSentryConfig } from "@sentry/nextjs";
// import { withAxiom } from "next-axiom";
import nextMdx from "@next/mdx";
import withSerwistInit from "@serwist/next";
import { env } from "./env";
import type { NextConfig } from "next";

const withMDX = nextMdx({
  options: {
    remarkPlugins: [[require.resolve("remark-gfm")]],
  },
});

const nextConfig: NextConfig = {
  reactStrictMode: true,
  output: process.env.DOCKER_BUILD === "true" ? "standalone" : undefined,
  // Skip TypeScript checking during E2E CI builds to save memory
  typescript: {
    ignoreBuildErrors: process.env.SKIP_TYPE_CHECK === "true",
  },
  serverExternalPackages: ["@sentry/nextjs", "@sentry/node"],
  turbopack: {
    rules: {
      "*.svg": {
        loaders: ["@svgr/webpack"],
        as: "*.js",
      },
    },
  },
  pageExtensions: ["js", "jsx", "mdx", "ts", "tsx"],
  images: {
    remotePatterns: [
      // YouTube and Mux video domains removed
      {
        protocol: "https",
        hostname: "ph-avatars.imgix.net",
      },
      {
        protocol: "https",
        hostname: "lh3.googleusercontent.com",
      },
      {
        protocol: "https",
        hostname: "cdn.sanity.io",
      },
      {
        protocol: "https",
        hostname: "images.inbox.sudiptadhara.in",
      },
      {
        protocol: "https",
        hostname: "t1.gstatic.com",
      },
      {
        protocol: "https",
        hostname: "cdn.outrank.so",
      },
    ],
  },
  async redirects() {
    return [
      {
        source: "/",
        destination: "/automation",
        has: [
          {
            type: "cookie",
            key: "__Secure-better-auth.session_token",
          },
        ],
        permanent: false,
      },
      {
        source: "/",
        destination: "/setup",
        has: [
          {
            type: "cookie",
            key: "__Secure-better-auth.session-token.1",
          },
        ],
        permanent: false,
      },
      // Internal redirects only - all external go.inbox / docs.inbox links removed
      {
        source: "/newsletters",
        destination: "/bulk-unsubscribe",
        permanent: false,
      },
      {
        source: "/request-access",
        destination: "/early-access",
        permanent: true,
      },
      {
        source: "/reply-tracker",
        destination: "/reply-zero",
        permanent: false,
      },
    ];
  },
  // ANALYTICS & PAYMENT PROXIES DISABLED FOR PRIVACY
  async rewrites() {
    return [
      // MCP OAuth 2.1 Discovery Endpoints (RFC 8414 / RFC 9728)
      // Rewrite .well-known paths to regular API routes (dots cause routing issues)
      {
        source: "/.well-known/oauth-authorization-server",
        destination: "/api/well-known-oauth/authorization-server",
      },
      {
        source: "/.well-known/oauth-protected-resource",
        destination: "/api/well-known-oauth/protected-resource",
      },
    ];
  },
  // Security headers: https://nextjs.org/docs/app/building-your-application/configuring/progressive-web-apps#8-securing-your-application
  async headers() {
    const securityHeaders = [
      {
        key: "X-Frame-Options",
        value: "DENY",
      },
      {
        key: "X-XSS-Protection",
        value: "1; mode=block",
      },
      {
        key: "X-Content-Type-Options",
        value: "nosniff",
      },
      {
        key: "Referrer-Policy",
        value: "strict-origin-when-cross-origin",
      },
      {
        key: "Content-Security-Policy",
        value: [
          "default-src 'self'",
          // Next.js needs these
          "script-src 'self' 'unsafe-inline' 'unsafe-eval' https:",
          // Needed for Tailwind/Shadcn
          "style-src 'self' 'unsafe-inline' https:",
          // Add this line to allow data: fonts
          "font-src 'self' data: https:",
          // For images including avatars and Mux thumbnails
          "img-src 'self' data: https: blob: https://image.mux.com https://*.litix.io",
          // For Mux video and audio content
          "media-src 'self' blob: https://*.mux.com",
          // If you use web workers or service workers
          "worker-src 'self' blob:",
          // For API calls, SWR, external services, and Mux
          "connect-src 'self' https: wss: https://*.mux.com https://*.litix.io",
          // iframes for Mux player
          "frame-src 'self' https:",
          // Prevent embedding in iframes
          "frame-ancestors 'none'",
        ].join("; "),
      },
      {
        key: "Strict-Transport-Security",
        value: "max-age=31536000",
      },
    ];

    return [
      {
        // Apply all security headers + static CORS to non-auth routes
        source: "/((?!api/auth).*)",
        headers: [
          ...securityHeaders,
          {
            key: "Access-Control-Allow-Origin",
            value: env.NEXT_PUBLIC_BASE_URL,
          },
          {
            key: "Access-Control-Allow-Methods",
            value: "GET, POST, PUT, DELETE, OPTIONS",
          },
        ],
      },
      {
        // Auth routes: security headers only, CORS handled by better-auth based on trustedOrigins
        source: "/api/auth/:path*",
        headers: securityHeaders,
      },
      {
        source: "/sw.js",
        headers: [
          {
            key: "Content-Type",
            value: "application/javascript; charset=utf-8",
          },
          {
            key: "Cache-Control",
            value: "no-cache, no-store, must-revalidate",
          },
          {
            key: "Content-Security-Policy",
            value: "default-src 'self'; script-src 'self' 'unsafe-eval'",
          },
        ],
      },
    ];
  },
};

// SENTRY DISABLED FOR PRIVACY
const mdxConfig = withMDX(nextConfig);
const exportConfig = mdxConfig;

// NEXTAUTH_SECRET is deprecated but kept as an option to not break the build. At least one must be set.
if (!env.AUTH_SECRET && !env.NEXTAUTH_SECRET) {
  throw new Error(
    "Either AUTH_SECRET or NEXTAUTH_SECRET environment variable must be defined",
  );
}

if (env.MICROSOFT_CLIENT_ID && !env.MICROSOFT_WEBHOOK_CLIENT_STATE) {
  throw new Error(
    "MICROSOFT_WEBHOOK_CLIENT_STATE environment variable must be defined",
  );
}

const withSerwist = withSerwistInit({
  swSrc: "app/sw.ts",
  swDest: "public/sw.js",
  disable: process.env.NODE_ENV !== "production",
  maximumFileSizeToCacheInBytes: 3 * 1024 * 1024, // 3MB
});

// AXIOM DISABLED FOR PRIVACY
export default withSerwist(exportConfig);
