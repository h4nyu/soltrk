import { performKeyExchange, encryptApiData, gtokenFromUserId } from "./crypto";

const API_BASE = "https://ankerpower-api-eu.anker.com";
const API_HEADERS = {
  "content-type": "application/json",
  "model-type": "DESKTOP",
  "app-name": "anker_power",
  "os-type": "android",
};

export type AnkerSession = {
  countryId: string;
  authToken: string;
  gtoken: string;
  userId: string;
};

export type AnkerDevice = {
  device_sn: string;
  // The raw API returns this as `product_code` - getBindDevices() copies it
  // to `device_pn` so callers have one consistent field name to use.
  device_pn: string;
  alias_name?: string;
  device_name?: string;
  wifi_online?: boolean;
  owner_user_id?: string;
  [key: string]: unknown;
};

export type AnkerMqttInfo = {
  thing_name: string;
  certificate_id: string;
  certificate_pem: string;
  private_key: string;
  aws_root_ca1_pem: string;
  endpoint_addr: string;
  app_name: string;
};

function timezoneOffsetMs(): number {
  return -new Date().getTimezoneOffset() * 60 * 1000;
}

async function ankerRequest<T>(
  session: AnkerSession | null,
  endpoint: string,
  body: Record<string, unknown>,
): Promise<T> {
  const headers: Record<string, string> = {
    ...API_HEADERS,
    country: session?.countryId ?? "",
  };
  if (session) {
    headers.gtoken = session.gtoken;
    headers["x-auth-token"] = session.authToken;
  }
  const res = await fetch(`${API_BASE}/${endpoint}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Anker API ${endpoint} -> HTTP ${res.status}`);
  }
  const json = (await res.json()) as { code: number; msg: string; data: T };
  if (json.code !== 0) {
    throw new Error(`Anker API ${endpoint} -> code ${json.code}: ${json.msg}`);
  }
  return json.data;
}

/**
 * Login flow reverse engineered from anker_solix_api/session.py
 * (async_authenticate): password is AES-256-CBC encrypted with a shared
 * secret derived via ECDH against Anker's fixed public key (see crypto.ts),
 * gtoken is md5(user_id) from the login response.
 */
export async function login(
  email: string,
  password: string,
  countryId: string,
): Promise<AnkerSession> {
  const { publicKeyHex, sharedSecret } = performKeyExchange();
  const data = await ankerRequest<{ user_id: string; auth_token: string }>(
    null,
    "passport/login",
    {
      ab: countryId,
      client_secret_info: { public_key: publicKeyHex },
      enc: 0,
      email,
      password: encryptApiData(password, sharedSecret),
      time_zone: timezoneOffsetMs(),
      transaction: String(Date.now()),
    },
  );
  return {
    countryId,
    authToken: data.auth_token,
    gtoken: gtokenFromUserId(data.user_id),
    userId: data.user_id,
  };
}

export async function getBindDevices(session: AnkerSession): Promise<AnkerDevice[]> {
  const data = await ankerRequest<{ data: AnkerDevice[] }>(
    session,
    "power_service/v1/app/get_relate_and_bind_devices",
    {},
  );
  return (data.data ?? []).map((d) => ({
    ...d,
    device_pn: d.device_pn ?? (d.product_code as string | undefined) ?? "",
  }));
}

export async function getUserMqttInfo(session: AnkerSession): Promise<AnkerMqttInfo> {
  return ankerRequest<AnkerMqttInfo>(session, "app/devicemanage/get_user_mqtt_info", {});
}
