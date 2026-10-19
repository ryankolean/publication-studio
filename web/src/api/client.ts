import type { Session } from "../auth/session.js";

export interface FieldError {
  field: string;
  message: string;
}

/** Everything the client throws is an ApiError, including network failures. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: FieldError[];

  constructor(status: number, code: string, message: string, details: FieldError[] = []) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }

  /** Field errors keyed for a form to render inline. */
  fieldErrors(): Record<string, string> {
    const map: Record<string, string> = {};
    for (const detail of this.details) map[detail.field] ??= detail.message;
    return map;
  }
}

export interface ApiClient {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
  patch<T>(path: string, body: unknown): Promise<T>;
  delete<T>(path: string): Promise<T>;
  /**
   * Raw bytes to a capability url the API minted (an image upload). The url
   * carries its own token, so no bearer token is sent and a 401 is final:
   * refreshing the session cannot revive an expired upload grant.
   *
   * fileName is the name the upload grant echoed back. It travels in the
   * x-file-name header, percent-encoded because header values must be
   * ISO-8859-1; the server decodes and sanitizes it again.
   */
  putBytes<T>(url: string, body: Blob, contentType: string, fileName?: string | null): Promise<T>;
}

interface ApiClientOptions {
  baseUrl: string;
  session: Session;
  fetch?: typeof globalThis.fetch;
}

async function toApiError(response: Response): Promise<ApiError> {
  try {
    const body = (await response.json()) as Record<string, unknown>;
    return new ApiError(
      response.status,
      typeof body["code"] === "string" ? body["code"] : "UNKNOWN",
      typeof body["message"] === "string" ? body["message"] : response.statusText,
      Array.isArray(body["details"]) ? (body["details"] as FieldError[]) : [],
    );
  } catch {
    return new ApiError(response.status, "UNKNOWN", response.statusText || "Request failed.");
  }
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const { session } = options;

  function headers(body: unknown): Record<string, string> {
    const result: Record<string, string> = {};
    if (body !== undefined) result["content-type"] = "application/json";
    const token = session.getAccessToken();
    if (token !== null) result["authorization"] = `Bearer ${token}`;
    return result;
  }

  async function send(path: string, method: string, body: unknown): Promise<Response> {
    return doFetch(`${options.baseUrl}${path}`, {
      method,
      headers: headers(body),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  /** Returns true when a fresh access token was obtained. */
  async function refresh(): Promise<boolean> {
    const refreshToken = session.getRefreshToken();
    if (refreshToken === null) return false;

    const response = await doFetch(`${options.baseUrl}/auth/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });

    if (!response.ok) {
      // The refresh token is spent or revoked; there is nothing left to try.
      session.signOut();
      return false;
    }

    const body = (await response.json()) as { access_token?: unknown };
    if (typeof body.access_token !== "string") {
      session.signOut();
      return false;
    }

    session.setAccessToken(body.access_token);
    return true;
  }

  async function request<T>(path: string, method: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await send(path, method, body);
    } catch {
      // A DNS failure or a CORS rejection surfaces as a TypeError with a
      // message that varies by browser; give the UI one stable shape.
      throw new ApiError(0, "NETWORK", "Could not reach the server.");
    }

    // Refreshing on a failed login would be nonsense, and one retry only, so a
    // server that always answers 401 cannot spin.
    if (response.status === 401 && !path.startsWith("/auth/")) {
      if (await refresh()) {
        try {
          response = await send(path, method, body);
        } catch {
          throw new ApiError(0, "NETWORK", "Could not reach the server.");
        }
      }
    }

    if (!response.ok) throw await toApiError(response);
    if (response.status === 204) return undefined as T;

    return (await response.json()) as T;
  }

  async function putBytes<T>(
    url: string,
    body: Blob,
    contentType: string,
    fileName: string | null = null,
  ): Promise<T> {
    const headers: Record<string, string> = { "content-type": contentType };
    if (fileName !== null && fileName !== "") headers["x-file-name"] = encodeURIComponent(fileName);
    let response: Response;
    try {
      response = await doFetch(`${options.baseUrl}${url}`, { method: "PUT", headers, body });
    } catch {
      throw new ApiError(0, "NETWORK", "Could not reach the server.");
    }
    if (!response.ok) throw await toApiError(response);
    return (await response.json()) as T;
  }

  return {
    get: <T,>(path: string) => request<T>(path, "GET"),
    post: <T,>(path: string, body: unknown) => request<T>(path, "POST", body),
    patch: <T,>(path: string, body: unknown) => request<T>(path, "PATCH", body),
    delete: <T,>(path: string) => request<T>(path, "DELETE"),
    putBytes,
  };
}
