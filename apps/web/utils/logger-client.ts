/** biome-ignore-all lint/suspicious/noConsole: we use console.log for development logs */
// AXIOM DISABLED FOR PRIVACY
// import { log } from "next-axiom";

/**
 * Client-safe logger that doesn't access server-side env vars.
 * Uses next-axiom for production logging (if NEXT_PUBLIC_AXIOM_TOKEN is set)
 * and falls back to console otherwise.
 */
export function createClientLogger(scope: string) {
  // AXIOM DISABLED FOR PRIVACY - always use console
  const hasAxiom = false;

  return {
    info: (message: string, args?: Record<string, unknown>) =>
      console.log(`[${scope}]:`, message, args ?? ""),
    error: (message: string, args?: Record<string, unknown>) =>
      console.error(`[${scope}]:`, message, args ?? ""),
    warn: (message: string, args?: Record<string, unknown>) =>
      console.warn(`[${scope}]:`, message, args ?? ""),
    flush: () => Promise.resolve(),
  };
}
