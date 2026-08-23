import mqtt, { MqttClient } from "mqtt";
import { AnkerDevice, AnkerMqttInfo, AnkerSession } from "./httpApi";
import { A1765Status, parseA1765ParamInfo } from "./protocol";

type OuterMessage = {
  head?: { device_pn?: string; device_sn?: string };
  payload?: string;
};

/**
 * Wraps the AWS IoT MQTT connection: topic naming, the outer JSON envelope
 * (reverse engineered from anker_solix_api/mqtt.py's publish()), and status
 * caching per device. Only understands the A1765 payload format - other
 * models would need their own decode wired into handleMessage.
 */
export class AnkerMqttSession {
  private client: MqttClient;
  private statusBySn = new Map<string, A1765Status>();
  private lastMessageAtBySn = new Map<string, number>();

  constructor(
    private readonly session: AnkerSession,
    private readonly mqttInfo: AnkerMqttInfo,
  ) {
    this.client = mqtt.connect(`mqtts://${mqttInfo.endpoint_addr}:8883`, {
      cert: mqttInfo.certificate_pem,
      key: mqttInfo.private_key,
      ca: mqttInfo.aws_root_ca1_pem,
      clientId: mqttInfo.thing_name,
      protocolVersion: 4,
      reconnectPeriod: 5000,
    });
    this.client.on("message", (topic, payload) => this.handleMessage(topic, payload));
  }

  async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.client.once("connect", () => resolve());
      this.client.once("error", (err) => reject(err));
    });
  }

  disconnect(): void {
    this.client.end(true);
  }

  private topicPrefix(device: AnkerDevice, publish: boolean): string {
    return `${publish ? "cmd" : "dt"}/${this.mqttInfo.app_name}/${device.device_pn}/${device.device_sn}/`;
  }

  subscribeDevice(device: AnkerDevice): void {
    this.client.subscribe(`${this.topicPrefix(device, false)}#`);
  }

  private handleMessage(topic: string, payload: Buffer): void {
    try {
      const outer = JSON.parse(payload.toString("utf-8")) as OuterMessage;
      const inner = JSON.parse(outer.payload ?? "{}") as { data?: string; trans?: string };
      const dataB64 = inner.data ?? inner.trans;
      if (typeof dataB64 !== "string") return;
      const data = Buffer.from(dataB64, "base64");

      const parts = topic.split("/");
      const pn = outer.head?.device_pn ?? parts[2];
      const sn = outer.head?.device_sn ?? parts[3];
      if (!sn) return;
      this.lastMessageAtBySn.set(sn, Date.now());
      if (pn === "A1765" && topic.endsWith("/param_info")) {
        this.statusBySn.set(sn, parseA1765ParamInfo(data));
      }
    } catch {
      // Not every message on this topic tree is our binary format (e.g.
      // app/res acks carry a plain status code) - ignore what we can't parse.
    }
  }

  getStatus(sn: string): A1765Status | undefined {
    return this.statusBySn.get(sn);
  }

  /** Wraps `hexbytes` in the envelope AWS IoT / the device expects and publishes it. */
  async publishCommand(device: AnkerDevice, hexbytes: Buffer): Promise<void> {
    const message = {
      head: {
        version: "1.0.0.1",
        client_id: `android-${this.mqttInfo.app_name}-${this.session.userId}-${this.mqttInfo.certificate_id}`,
        sess_id: "1234-5678",
        msg_seq: 1,
        seed: 1,
        timestamp: Math.floor(Date.now() / 1000),
        cmd_status: 2,
        cmd: 17,
        sign_code: 1,
        device_pn: device.device_pn,
        device_sn: device.device_sn,
      },
      payload: JSON.stringify({
        device_sn: device.device_sn,
        account_id: (device.owner_user_id as string | undefined) ?? this.session.userId,
        data: hexbytes.toString("base64"),
      }),
    };
    const topic = `${this.topicPrefix(device, true)}req`;
    await new Promise<void>((resolve, reject) => {
      this.client.publish(topic, JSON.stringify(message), { qos: 0 }, (err) =>
        err ? reject(err) : resolve(),
      );
    });
  }
}
