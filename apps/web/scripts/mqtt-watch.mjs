// Usage: node scripts/mqtt-watch.mjs 'inbox/#' 20
import mqtt from "mqtt";

const [filter = "inbox/#", seconds = "15"] = process.argv.slice(2);
const client = mqtt.connect(
  `mqtt://${process.env.MQTT_HOST}:${process.env.MQTT_PORT || 1883}`,
  { username: process.env.MQTT_USERNAME, password: process.env.MQTT_PASSWORD },
);

client.on("connect", () => {
  client.subscribe(filter);
  setTimeout(
    () => client.end(true, () => process.exit(0)),
    Number(seconds) * 1000,
  );
});
client.on("message", (topic, payload) =>
  console.log(`${topic}\n    ${payload.toString().slice(0, 300)}\n`),
);
client.on("error", (error) => {
  console.error("mqtt error:", error.message);
  process.exit(1);
});
