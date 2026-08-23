import mqtt from "mqtt";
import { Result } from "@soltrk/core";
import { login, getBindDevices, getUserMqttInfo } from "./http-api";

/**
 * One-off diagnostic: subscribe to BOTH the device->cloud (`dt/.../#`) and
 * app->device (`cmd/.../#`) topic trees for one device and log every raw
 * message. Used to reverse engineer new commands (e.g. the real Anker app's
 * TOU mode switch) the same way `set_charge_limit` was found - by watching
 * what the app itself publishes while you perform the action in it. Run via
 * `soltrk capture-mqtt <device_sn>` (see packages/cli/src/index.ts).
 */
export async function captureMqtt(
  targetSn: string,
  email: string,
  password: string,
  country: string,
): Promise<void> {
  const session = await login(email, password, country);
  if (Result.isErr(session)) throw session;

  const devices = await getBindDevices(session);
  if (Result.isErr(devices)) throw devices;
  const device = devices.find((d) => d.device_sn === targetSn);
  if (!device) {
    throw new Error(`No bound device with sn ${targetSn} (have: ${devices.map((d) => d.device_sn).join(", ")})`);
  }

  const mqttInfo = await getUserMqttInfo(session);
  if (Result.isErr(mqttInfo)) throw mqttInfo;

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
