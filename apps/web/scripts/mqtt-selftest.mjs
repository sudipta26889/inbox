// Usage: node scripts/mqtt-selftest.mjs
// Exits non-zero if the fail-soft path is broken OR silently inert.
import mqtt from "mqtt";

// TEST-NET-1: reserved by RFC 5737, guaranteed unroutable. Connecting here
// exercises the real failure path rather than a mocked one.
const client = mqtt.connect("mqtt://192.0.2.1:1883", {
  connectTimeout: 2000,
  reconnectPeriod: 0,
});

let errored = false;
client.on("error", () => {
  errored = true;
});

setTimeout(() => {
  client.end(true);
  if (!errored) {
    console.error("FAIL: unroutable broker produced no error event");
    process.exit(1);
  }
  console.log("OK: unroutable broker surfaces an error rather than hanging");
  process.exit(0);
}, 4000);
