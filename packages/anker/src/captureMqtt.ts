/**
 * One-off diagnostic: subscribe to BOTH the device->cloud (`dt/.../#`) and
 * app->device (`cmd/.../#`) topic trees for one device and log every raw
 * message. Used to reverse engineer new commands (e.g. the real Anker app's
 * TOU mode switch) the same way `set_charge_limit` was found - by watching
 * what the app itself publishes while you perform the action in it. Run
 * inside the container:
 *
 *   docker compose run --rm soltrk npx tsx packages/anker/src/captureMqtt.ts <device_sn>
 */
import mqtt from "mqtt";
import { login, getBindDevices, getUserMqttInfo, AnkerDevice } from "./httpApi";

async function main() {
  const targetSn = process.argv[2];
  if (!targetSn) {
    console.error("Usage: captureMqtt.ts <device_sn>");
    process.exit(1);
  }

  const email = process.env.ANKER_EMAIL;
  const password = process.env.ANKER_PASSWORD;
  const country = process.env.ANKER_COUNTRY ?? "JP";
  if (!email || !password) {
    console.error("Missing ANKER_EMAIL / ANKER_PASSWORD env vars");
    process.exit(1);
  }

  const session = await login(email, password, country);
  if (session instanceof Error) {
    console.error("login failed:", session.message);
    process.exit(1);
  }
  const devices = await getBindDevices(session);
  if (devices instanceof Error) {
    console.error("getBindDevices failed:", devices.message);
    process.exit(1);
  }
  const device = devices.find((d) => d.device_sn === targetSn);
  if (!device) {
    console.error(`No bound device with sn ${targetSn} (have: ${devices.map((d) => d.device_sn).join(", ")})`);
    process.exit(1);
  }
  const mqttInfo = await getUserMqttInfo(session);
  if (mqttInfo instanceof Error) {
    console.error("getUserMqttInfo failed:", mqttInfo.message);
    process.exit(1);
  }

  const client = mqtt.connect(`mqtts://${mqttInfo.endpoint_addr}:8883`, {
    cert: mqttInfo.certificate_pem,
    key: mqttInfo.private_key,
    ca: mqttInfo.aws_root_ca1_pem,
    clientId: mqttInfo.thing_name,
    protocolVersion: 4,
  });

  await new Promise<void>((resolve, reject) => {
    client.once("connect", () => resolve());
    client.once("error", reject);
  });

  const dtTopic = `dt/${mqttInfo.app_name}/${device.device_pn}/${device.device_sn}/#`;
  const cmdTopic = `cmd/${mqttInfo.app_name}/${device.device_pn}/${device.device_sn}/#`;
  client.subscribe([dtTopic, cmdTopic], (err) => {
    if (err) console.error("subscribe error:", err.message);
  });

  console.log(`Subscribed to:\n  ${dtTopic}\n  ${cmdTopic}`);
  console.log("Now perform the action in the Anker app. Logging every message (Ctrl+C to stop)...\n");

  client.on("message", (topic, payload) => {
    console.log(`[${new Date().toISOString()}] ${topic}`);
    try {
      const outer = JSON.parse(payload.toString("utf-8"));
      console.log("  outer:", JSON.stringify(outer.head ?? {}));
      const inner = typeof outer.payload === "string" ? JSON.parse(outer.payload) : undefined;
      const dataB64 = inner?.data ?? inner?.trans;
      if (typeof dataB64 === "string") {
        console.log("  data (hex):", Buffer.from(dataB64, "base64").toString("hex"));
      } else {
        console.log("  raw payload:", JSON.stringify(outer.payload ?? outer));
      }
    } catch {
      console.log("  raw (non-JSON):", payload.toString("utf-8"));
    }
    console.log();
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
