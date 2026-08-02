import type { ApiResponse } from "@dynamic-ai/protocol";

export const API_URL = (import.meta.env.VITE_API_URL ?? "").replace(/\/$/, "");
export const WS_URL = (API_URL || window.location.origin).replace(/^http/, "ws");
let csrfToken: string | null = null;

export function setCsrfToken(value: string | null) {
  csrfToken = value;
}

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (csrfToken && init?.method && !["GET", "HEAD", "OPTIONS"].includes(init.method.toUpperCase())) {
    headers.set("X-CSRF-Token", csrfToken);
  }
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    credentials: "include",
    headers,
  });
  const body = await response.json().catch(() => ({
    ok: false,
    code: "INVALID_SERVER_RESPONSE",
    message: "서버 응답을 해석할 수 없습니다.",
    data: null,
    retryable: false,
  })) as ApiResponse<T>;
  if (!response.ok || !body.ok) {
    throw new ApiError(body.code, body.message, response.status);
  }
  return body.data;
}
