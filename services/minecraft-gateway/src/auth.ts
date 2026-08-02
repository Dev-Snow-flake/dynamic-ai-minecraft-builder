import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

const SESSION_TTL_MS = 12 * 60 * 60 * 1_000;
const MAX_SESSIONS = 128;

export type AuthRole = "Viewer" | "Reviewer" | "Operator" | "Admin";
const roleRank: Record<AuthRole, number> = { Viewer: 0, Reviewer: 1, Operator: 2, Admin: 3 };

export interface AuthSession {
  authenticated: true;
  actor: string;
  role: AuthRole;
  csrfToken: string;
  expiresAt: string;
}

interface StoredSession extends AuthSession {
  id: string;
  expiresAtMs: number;
}

export class SessionAuth {
  private readonly sessions = new Map<string, StoredSession>();
  private readonly passwordHashes: Array<{ role: AuthRole; hash: Buffer }>;
  private readonly secureCookie: boolean;
  private readonly cookieName: string;

  constructor(password?: string | Partial<Record<AuthRole, string>>, production = process.env.NODE_ENV === "production") {
    const configured = typeof password === "string"
      ? { Admin: password }
      : password ?? {
          Admin: process.env.CONTROL_CENTER_PASSWORD?.trim(),
          Operator: process.env.CONTROL_CENTER_OPERATOR_PASSWORD?.trim(),
          Reviewer: process.env.CONTROL_CENTER_REVIEWER_PASSWORD?.trim(),
          Viewer: process.env.CONTROL_CENTER_VIEWER_PASSWORD?.trim(),
        };
    const configuredEntries = (Object.entries(configured) as Array<[AuthRole, string | undefined]>)
      .filter((entry): entry is [AuthRole, string] => Boolean(entry[1]));
    const invalidRole = configuredEntries.find(([, value]) => value.length < 16)?.[0];
    if (invalidRole) throw new Error(`${invalidRole} control-center password must contain at least 16 characters.`);
    this.passwordHashes = configuredEntries
      .map(([role, value]) => ({ role, hash: hash(value) }));
    this.secureCookie = production;
    this.cookieName = production ? "__Host-dynamic_ai_session" : "dynamic_ai_session";
  }

  get configured() {
    return this.passwordHashes.length > 0;
  }

  login(password: unknown): StoredSession | null {
    if (this.passwordHashes.length === 0 || typeof password !== "string" || password.length > 512) return null;
    const supplied = hash(password);
    const credential = this.passwordHashes.find((candidate) => timingSafeEqual(candidate.hash, supplied));
    if (!credential) return null;

    this.purge();
    if (this.sessions.size >= MAX_SESSIONS) {
      const oldest = [...this.sessions.values()].sort((left, right) => left.expiresAtMs - right.expiresAtMs)[0];
      if (oldest) this.sessions.delete(oldest.id);
    }

    const id = randomBytes(32).toString("base64url");
    const expiresAtMs = Date.now() + SESSION_TTL_MS;
    const session: StoredSession = {
      id,
      authenticated: true,
      actor: `${credential.role} 사용자`,
      role: credential.role,
      csrfToken: randomBytes(24).toString("base64url"),
      expiresAtMs,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
    this.sessions.set(id, session);
    return session;
  }

  read(request: Request): StoredSession | null {
    return this.readCookieHeader(request.header("cookie") ?? "");
  }

  readCookieHeader(header: string): StoredSession | null {
    const id = parseCookies(header).get(this.cookieName);
    if (!id) return null;
    const session = this.sessions.get(id);
    if (!session) return null;
    if (session.expiresAtMs <= Date.now()) {
      this.sessions.delete(id);
      return null;
    }
    return session;
  }

  logout(request: Request) {
    const session = this.read(request);
    if (session) this.sessions.delete(session.id);
  }

  setCookie(response: Response, session: StoredSession) {
    const secure = this.secureCookie ? "; Secure" : "";
    response.setHeader(
      "Set-Cookie",
      `${this.cookieName}=${session.id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS / 1_000)}${secure}`,
    );
  }

  clearCookie(response: Response) {
    const secure = this.secureCookie ? "; Secure" : "";
    response.setHeader("Set-Cookie", `${this.cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`);
  }

  publicSession(session: StoredSession): AuthSession {
    const { authenticated, actor, role, csrfToken, expiresAt } = session;
    return { authenticated, actor, role, csrfToken, expiresAt };
  }

  requireSession = (request: Request, response: Response, next: NextFunction) => {
    const session = this.read(request);
    if (!session) {
      response.status(401).json({ ok: false, code: "AUTH_REQUIRED", message: "관리자 로그인이 필요합니다.", data: null, retryable: false });
      return;
    }
    response.locals.authSession = session;
    next();
  };

  requireCsrf = (request: Request, response: Response, next: NextFunction) => {
    if (["GET", "HEAD", "OPTIONS"].includes(request.method)) {
      next();
      return;
    }
    const session = response.locals.authSession as StoredSession | undefined;
    const supplied = request.header("x-csrf-token") ?? "";
    if (!session || !safeTextEqual(session.csrfToken, supplied)) {
      response.status(403).json({ ok: false, code: "CSRF_FAILED", message: "보안 토큰이 만료되었습니다. 다시 로그인해 주세요.", data: null, retryable: false });
      return;
    }
    next();
  };

  requireRole(required: AuthRole) {
    return (_request: Request, response: Response, next: NextFunction) => {
      const session = response.locals.authSession as StoredSession | undefined;
      if (!session || roleRank[session.role] < roleRank[required]) {
        response.status(403).json({ ok: false, code: "FORBIDDEN", message: `${required} 역할 이상이 필요합니다.`, data: null, retryable: false });
        return;
      }
      next();
    };
  }

  private purge() {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (session.expiresAtMs <= now) this.sessions.delete(id);
    }
  }
}

export function authActor(response: Response) {
  const session = response.locals.authSession as StoredSession | undefined;
  return session?.actor ?? "인증되지 않은 사용자";
}

function hash(value: string) {
  return createHash("sha256").update(value, "utf8").digest();
}

function safeTextEqual(expected: string, supplied: string) {
  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(supplied, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

function parseCookies(header: string) {
  const result = new Map<string, string>();
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name && value) result.set(name, value);
  }
  return result;
}
