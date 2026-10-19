import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError, createApiClient } from "./client.js";
import { createSession, type StorageLike } from "../auth/session.js";

function fakeStorage(): StorageLike {
  const entries = new Map<string, string>();
  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => void entries.set(key, value),
    removeItem: (key) => void entries.delete(key),
  };
}

const USER = { id: "u1", email: "p@example.com", name: "Partner", role: "photographer" };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let session: ReturnType<typeof createSession>;
let fetchMock: ReturnType<typeof vi.fn>;

const client = () =>
  createApiClient({ baseUrl: "https://api.example.com", session, fetch: fetchMock as never });

beforeEach(() => {
  session = createSession(fakeStorage());
  fetchMock = vi.fn();
});

describe("requests", () => {
  it("prefixes the configured base url", async () => {
    fetchMock.mockResolvedValueOnce(json({ ok: true }));
    await client().get("/health");
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.example.com/health");
  });

  it("sends no Authorization header when signed out", async () => {
    fetchMock.mockResolvedValueOnce(json({ ok: true }));
    await client().get("/health");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>)["authorization"]).toBeUndefined();
  });

  it("attaches the access token when signed in", async () => {
    session.signIn({ accessToken: "access-1", refreshToken: "refresh-1", user: USER });
    fetchMock.mockResolvedValueOnce(json({ ok: true }));
    await client().get("/events");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>)["authorization"]).toBe("Bearer access-1");
  });

  it("posts json with the right content type", async () => {
    fetchMock.mockResolvedValueOnce(json({ id: "w1" }, 201));
    await client().post("/events", { coupleNames: "A and B" });
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(init.body).toBe(JSON.stringify({ coupleNames: "A and B" }));
  });
});

describe("errors", () => {
  it("throws a typed error carrying the server code", async () => {
    fetchMock.mockResolvedValueOnce(
      json({ code: "VALIDATION", message: "Some fields need attention.", details: [{ field: "coupleNames", message: "Required." }] }, 400),
    );

    await expect(client().post("/events", {})).rejects.toMatchObject({
      code: "VALIDATION",
      status: 400,
      details: [{ field: "coupleNames", message: "Required." }],
    });
  });

  it("still throws an ApiError when the body is not json", async () => {
    fetchMock.mockResolvedValueOnce(new Response("gateway blew up", { status: 502 }));
    const error = await client().get("/events").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(502);
  });

  it("reports a network failure as an ApiError rather than leaking the raw error", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const error = await client().get("/events").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("NETWORK");
  });
});

describe("token refresh", () => {
  it("refreshes once on a 401 and replays the request", async () => {
    session.signIn({ accessToken: "stale", refreshToken: "refresh-1", user: USER });

    fetchMock
      .mockResolvedValueOnce(json({ code: "UNAUTHORIZED", message: "no" }, 401))
      .mockResolvedValueOnce(json({ access_token: "fresh", expires_in: 900 }))
      .mockResolvedValueOnce(json({ events: [] }));

    await expect(client().get("/events")).resolves.toEqual({ events: [] });

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "https://api.example.com/events",
      "https://api.example.com/auth/refresh",
      "https://api.example.com/events",
    ]);
    expect(session.getAccessToken()).toBe("fresh");
  });

  it("replays with the new token, not the stale one", async () => {
    session.signIn({ accessToken: "stale", refreshToken: "refresh-1", user: USER });
    fetchMock
      .mockResolvedValueOnce(json({ code: "UNAUTHORIZED" }, 401))
      .mockResolvedValueOnce(json({ access_token: "fresh" }))
      .mockResolvedValueOnce(json({ events: [] }));

    await client().get("/events");
    const replay = fetchMock.mock.calls[2]?.[1] as RequestInit;
    expect((replay.headers as Record<string, string>)["authorization"]).toBe("Bearer fresh");
  });

  it("signs out when the refresh itself is rejected", async () => {
    session.signIn({ accessToken: "stale", refreshToken: "expired", user: USER });
    fetchMock
      .mockResolvedValueOnce(json({ code: "UNAUTHORIZED" }, 401))
      .mockResolvedValueOnce(json({ code: "UNAUTHORIZED" }, 401));

    await expect(client().get("/events")).rejects.toBeInstanceOf(ApiError);
    expect(session.getUser()).toBeNull();
    expect(session.getRefreshToken()).toBeNull();
  });

  it("does not retry more than once, so a persistent 401 cannot loop", async () => {
    session.signIn({ accessToken: "stale", refreshToken: "refresh-1", user: USER });
    fetchMock
      .mockResolvedValueOnce(json({ code: "UNAUTHORIZED" }, 401))
      .mockResolvedValueOnce(json({ access_token: "fresh" }))
      .mockResolvedValueOnce(json({ code: "UNAUTHORIZED" }, 401));

    await expect(client().get("/events")).rejects.toBeInstanceOf(ApiError);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not attempt a refresh when there is no refresh token", async () => {
    fetchMock.mockResolvedValueOnce(json({ code: "UNAUTHORIZED" }, 401));
    await expect(client().get("/events")).rejects.toBeInstanceOf(ApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not try to refresh a failed login", async () => {
    fetchMock.mockResolvedValueOnce(json({ code: "INVALID_CREDENTIALS" }, 401));
    await expect(
      client().post("/auth/login", { email: "a@b.c", password: "wrong" }),
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
