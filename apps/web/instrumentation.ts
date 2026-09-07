/* eslint-disable no-process-env */
import * as Sentry from "@sentry/nextjs";

export function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // this is your Sentry.init call from `sentry.server.config.js|ts`
    Sentry.init({
      dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
      // Adjust this value in production, or use tracesSampler for greater control
      tracesSampleRate: 1,
      // Setting this option to true will print useful information to the console while you're setting up Sentry.
      debug: false,
      // uncomment the line below to enable Spotlight (https://spotlightjs.com)
      // spotlight: process.env.NODE_ENV === 'development',
    });

    // MQTT connects lazily on first publish otherwise, so the "online"
    // announcement doesn't fire until the next cron pass — up to a cron
    // period of every restart/deploy reporting inbox/availability as
    // "offline" (the last will from the previous process) while the app is
    // actually healthy. Connecting here makes boot itself the trigger.
    // Node-only: MQTT uses TCP sockets, unavailable on the edge runtime.
    import("@/utils/mqtt/client")
      .then(({ connectMqtt }) => connectMqtt())
      .catch(() => {});
  }

  // This is your Sentry.init call from `sentry.edge.config.js|ts`
  if (process.env.NEXT_RUNTIME === "edge") {
    Sentry.init({
      dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
      // Adjust this value in production, or use tracesSampler for greater control
      tracesSampleRate: 1,
      // Setting this option to true will print useful information to the console while you're setting up Sentry.
      debug: false,
    });
  }
}

export const onRequestError = Sentry.captureRequestError;
