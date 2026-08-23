import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import { Result } from "@soltrk/core";
import { login } from "./http-api";

function mockFetchOnce(status: number, body: unknown): void {
  mock.method(globalThis, "fetch", async () => new Response(JSON.stringify(body), { status }));
}

describe("login", () => {
  test("returns an AnkerSession on a successful response", async () => {
    mockFetchOnce(200, { code: 0, msg: "success", data: { user_id: "u1", auth_token: "t1" } });

    const result = await login("a@b.com", "pw", "JP");

    assert.ok(Result.isOk(result));
    assert.equal(result.userId, "u1");
    assert.equal(result.authToken, "t1");
    assert.equal(result.countryId, "JP");

    mock.reset();
  });

  test("returns a kind:http_error on a non-2xx HTTP response", async () => {
    mockFetchOnce(500, {});

    const result = await login("a@b.com", "pw", "JP");

    assert.ok(Result.isErr(result));
    assert.ok(result.kind === "http_error");
    assert.equal(result.status, 500);

    mock.reset();
  });

  test("parses an account lockout into kind:account_locked with the stated minutes", async () => {
    // Real observed response shape (code + free-text message, no
    // structured retry-after field).
    mockFetchOnce(200, {
      code: 10019,
      msg: "Due to 5 unsuccessful sign in attempts, your account has been disabled for 9 minutes. Please try again later.",
      data: null,
    });

    const result = await login("a@b.com", "pw", "JP");

    assert.ok(Result.isErr(result));
    assert.ok(result.kind === "account_locked");
    assert.equal(result.code, 10019);
    assert.equal(result.retryAfterMinutes, 9);

    mock.reset();
  });

  test("falls back to kind:api_error for a non-lockout API error code", async () => {
    mockFetchOnce(200, { code: 26161, msg: "Failed to request.", data: null });

    const result = await login("a@b.com", "pw", "JP");

    assert.ok(Result.isErr(result));
    assert.ok(result.kind === "api_error");
    assert.equal(result.code, 26161);

    mock.reset();
  });
});
