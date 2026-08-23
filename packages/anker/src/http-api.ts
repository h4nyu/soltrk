import { Result } from "@soltrk/core";
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

// Plain Error instances tagged with a discriminant `kind` field, rather
// than a class hierarchy - a real Error (stack trace, works with
// `instanceof Error` for Result's own T | E narrowing), narrowed further by
// callers via `"kind" in result && result.kind === "..."`.
export type AnkerHttpError = Error & { kind: "http_error"; status: number };
export type AnkerApiError = Error & { kind: "api_error"; code: number };
// Anker's account-lockout response (observed as code 10019) only gives the
// retry window as English prose ("...disabled for 9 minutes...") - there's
// no structured field for it, so it's parsed out of the message once here
// rather than leaving every caller to re-parse a free-text string.
export type AccountLockedError = Error & {
  kind: "account_locked";
  code: number;
  retryAfterMinutes: number;
};
export type AnkerError = AnkerHttpError | AnkerApiError | AccountLockedError;

function httpError(status: number, endpoint: string): AnkerHttpError {
  return Object.assign(new Error(`Anker API ${endpoint} -> HTTP ${status}`), {
    kind: "http_error" as const,
    status,
  });
}

const LOCKOUT_MINUTES_PATTERN = /disabled for (\d+) minutes?/i;

function apiError(code: number, endpoint: string, apiMessage: string): AnkerApiError | AccountLockedError {
  const message = `Anker API ${endpoint} -> code ${code}: ${apiMessage}`;
  const lockout = apiMessage.match(LOCKOUT_MINUTES_PATTERN);
  if (lockout) {
    return Object.assign(new Error(message), {
      kind: "account_locked" as const,
      code,
      retryAfterMinutes: Number(lockout[1]),
    });
  }
  return Object.assign(new Error(message), { kind: "api_error" as const, code });
}

function timezoneOffsetMs(): number {
  return -new Date().getTimezoneOffset() * 60 * 1000;
}

async function ankerRequest<T>(
  session: AnkerSession | null,
  endpoint: string,
  body: Record<string, unknown>,
): Promise<Result<T, AnkerError>> {
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
  if (!res.ok) return httpError(res.status, endpoint);

  const json = (await res.json()) as { code: number; msg: string; data: T };
  if (json.code !== 0) return apiError(json.code, endpoint, json.msg);
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
): Promise<Result<AnkerSession, AnkerError>> {
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
  if (data instanceof Error) return data;
  return {
    countryId,
    authToken: data.auth_token,
    gtoken: gtokenFromUserId(data.user_id),
    userId: data.user_id,
  };
}

export async function getBindDevices(
  session: AnkerSession,
): Promise<Result<AnkerDevice[], AnkerError>> {
  const data = await ankerRequest<{ data: AnkerDevice[] }>(
    session,
    "power_service/v1/app/get_relate_and_bind_devices",
    {},
  );
  if (data instanceof Error) return data;
  return (data.data ?? []).map((d) => ({
    ...d,
    device_pn: d.device_pn ?? (d.product_code as string | undefined) ?? "",
  }));
}

export async function getUserMqttInfo(
  session: AnkerSession,
): Promise<Result<AnkerMqttInfo, AnkerError>> {
  return ankerRequest<AnkerMqttInfo>(session, "app/devicemanage/get_user_mqtt_info", {});
}
