import { createServer, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { isIP } from "node:net";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import { WebSocket, WebSocketServer } from "ws";
import type { ApiResponse, EventEnvelope, WsEventPayload } from "@dynamic-ai/protocol";
import { ArchitectError, OpenAiArchitectService, type ArchitectService } from "./architect.js";
import { authActor, SessionAuth } from "./auth.js";
import { OpenAiKeyStoreError } from "./openai-key-store.js";
import { ControlCenterStore, StoreError } from "./store.js";

function api<T>(data: T, message = "ok", code = "OK"): ApiResponse<T> {
  return { ok: true, code, message, data, retryable: false };
}

export function createGateway(
  store = new ControlCenterStore(),
  architect: ArchitectService = new OpenAiArchitectService(),
  auth = new SessionAuth(),
) {
  const app = express();
  const httpServer = createServer(app);
  const eventWss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const bridgeWss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
  const bridgePollers = new Map<WebSocket, NodeJS.Timeout>();
  const bridgeServerIds = new Map<WebSocket, string>();
  const bridgeClientsByServerId = new Map<string, WebSocket>();
  const eventClientCookies = new Map<WebSocket, string>();
  const pendingBridgeCommands = new Map<string, {
    serverId: string;
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }>();
  const architectRequests = new Map<string, number[]>();
  const loginRequests = new Map<string, number[]>();
  const sendBridgeCommand = (serverId: string, method: string, payload: unknown, timeoutMs = 15_000) => {
    const client = bridgeClientsByServerId.get(serverId);
    if (!client || client.readyState !== WebSocket.OPEN) {
      throw new BridgeCommandError("BRIDGE_DISCONNECTED", "Paper Bridge가 연결되어 있지 않습니다.", 503);
    }
    const messageId = `msg_${crypto.randomUUID()}`;
    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingBridgeCommands.delete(messageId);
        reject(new BridgeCommandError("BRIDGE_TIMEOUT", "Paper Bridge 응답 시간이 초과되었습니다.", 504));
      }, timeoutMs);
      timeout.unref();
      pendingBridgeCommands.set(messageId, { serverId, resolve, reject, timeout });
      client.send(JSON.stringify({
        protocolVersion: 1,
        type: "command",
        messageId,
        serverId,
        sequence: 0,
        timestamp: new Date().toISOString(),
        method,
        payload,
      }), (error) => {
        if (!error) return;
        const pending = pendingBridgeCommands.get(messageId);
        if (!pending) return;
        clearTimeout(pending.timeout);
        pendingBridgeCommands.delete(messageId);
        reject(new BridgeCommandError("BRIDGE_SEND_FAILED", "Paper Bridge에 명령을 전송하지 못했습니다.", 502));
      });
    });
  };
  app.disable("x-powered-by");
  const allowedOrigins = new Set([
    "http://127.0.0.1:5173",
    "http://localhost:5173",
    "https://map.work-plus.kr",
    ...(process.env.WEB_ORIGIN ? process.env.WEB_ORIGIN.split(",").map((origin) => origin.trim()) : []),
  ]);

  app.use((request, response, next) => {
    const origin = request.header("origin");
    if (origin && !allowedOrigins.has(origin)) {
      response.status(403).json({ ok: false, code: "ORIGIN_NOT_ALLOWED", message: "허용되지 않은 출처입니다.", data: null, retryable: false });
      return;
    }
    if (origin && allowedOrigins.has(origin)) {
      response.setHeader("Access-Control-Allow-Origin", origin);
      response.setHeader("Vary", "Origin");
      response.setHeader("Access-Control-Allow-Credentials", "true");
    }
    response.setHeader("Access-Control-Allow-Headers", "Content-Type, X-CSRF-Token");
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    response.setHeader("Cache-Control", request.path.startsWith("/api/") ? "no-store" : "no-cache");
    if (request.method === "OPTIONS") {
      response.sendStatus(204);
      return;
    }
    next();
  });
  app.use("/api/v1/architect/messages", express.json({ limit: "11mb" }));
  app.use(express.json({ limit: "256kb" }));

  app.get("/health", (_request, response) => response.json(api({ status: "ready", protocolVersion: 1 })));

  app.post("/api/v1/auth/login", (request, response) => {
    if (!auth.configured) {
      response.status(503).json({ ok: false, code: "AUTH_NOT_CONFIGURED", message: "서버 관리자 비밀번호가 설정되지 않았습니다.", data: null, retryable: false });
      return;
    }
    if (!enforceWindowRateLimit(clientAddress(request), loginRequests, 10, 15 * 60 * 1_000)) {
      response.status(429).json({ ok: false, code: "LOGIN_RATE_LIMITED", message: "로그인 시도가 너무 많습니다. 잠시 뒤 다시 시도해 주세요.", data: null, retryable: true });
      return;
    }
    const session = auth.login(request.body?.password);
    if (!session) {
      response.status(401).json({ ok: false, code: "INVALID_CREDENTIALS", message: "관리자 비밀번호가 올바르지 않습니다.", data: null, retryable: false });
      return;
    }
    auth.setCookie(response, session);
    response.json(api(auth.publicSession(session), "로그인했습니다.", "AUTHENTICATED"));
  });
  app.get("/api/v1/auth/session", auth.requireSession, (_request, response) => {
    response.json(api(auth.publicSession(response.locals.authSession), "인증된 세션입니다.", "AUTHENTICATED"));
  });
  app.post("/api/v1/auth/logout", auth.requireSession, auth.requireCsrf, (request, response) => {
    auth.logout(request);
    auth.clearCookie(response);
    response.json(api({ authenticated: false }, "로그아웃했습니다.", "SIGNED_OUT"));
  });

  app.use("/api/v1", auth.requireSession, auth.requireCsrf);
  app.get("/api/v1/servers", (_request, response) => response.json(api([store.getServer()])));
  app.get("/api/v1/servers/:serverId/status", (_request, response) => response.json(api(store.getServer())));
  app.get("/api/v1/builds", (_request, response) => response.json(api(store.getJobs())));
  app.get("/api/v1/builds/:buildId", (_request, response) => response.json(api(store.getJob())));
  app.get("/api/v1/builds/:buildId/blueprints/:version", (_request, response) => response.json(api(store.getJob().blueprint)));
  app.get("/api/v1/builds/:buildId/events", (request, response) => {
    const after = Number(request.query.after ?? 0);
    response.json(api(store.getEvents(Number.isFinite(after) ? after : 0)));
  });
  app.get("/api/v1/builds/:buildId/site-snapshot", (_request, response) => response.json(api(store.getSiteSnapshot())));
  app.get("/api/v1/audit-events", (_request, response) => response.json(api(store.getAuditEvents())));
  app.get("/api/v1/architect/status", (_request, response) => response.json(api(architect.status())));

  app.post("/api/v1/settings/openai-key", auth.requireRole("Admin"), async (request, response, next) => {
    try {
      if (!architect.configureApiKey) throw new OpenAiKeyStoreError("OPENAI_KEY_STORE_NOT_SUPPORTED", "이 배포에서는 웹 키 저장을 지원하지 않습니다.", 503);
      const status = await architect.configureApiKey(String(request.body?.apiKey ?? ""));
      response.json(api(status, "OpenAI API 키를 암호화해 서버에 저장했습니다.", "OPENAI_KEY_SAVED"));
    } catch (error) {
      next(error);
    }
  });
  app.delete("/api/v1/settings/openai-key", auth.requireRole("Admin"), async (_request, response, next) => {
    try {
      if (!architect.clearApiKey) throw new OpenAiKeyStoreError("OPENAI_KEY_STORE_NOT_SUPPORTED", "이 배포에서는 웹 키 저장을 지원하지 않습니다.", 503);
      const status = await architect.clearApiKey();
      response.json(api(status, "저장된 OpenAI API 키를 삭제했습니다.", "OPENAI_KEY_REMOVED"));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/v1/architect/messages", auth.requireRole("Operator"), async (request, response, next) => {
    try {
      enforceArchitectRateLimit(request, architectRequests);
      const generated = await architect.generate(request.body);
      const published = generated.design
        ? store.publishAiDesign(
            generated.design,
            String(request.body?.message ?? "AI 설계 요청"),
            generated.model,
            request.body.target as { world: string; origin: { x: number; y: number; z: number } },
          )
        : { job: null, snapshot: null };
      response.json(api({ ...generated, ...published }, generated.design ? "AI 청사진을 승인 대기열에 게시했습니다." : "AI 응답을 생성했습니다.", "ARCHITECT_REPLIED"));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/v1/builds/:buildId/approvals", auth.requireRole("Reviewer"), async (request, response, next) => {
    try {
      const { decision, comment = "", planVersion } = request.body as Record<string, unknown>;
      if (!(["approved", "rejected", "changes_requested"] as unknown[]).includes(decision)) {
        response.status(400).json({ ok: false, code: "INVALID_DECISION", message: "지원하지 않는 승인 결정입니다.", data: null, retryable: false });
        return;
      }
      if (decision === "approved") {
        const plan = store.getExecutionPlan(Number(planVersion));
        await sendBridgeCommand(store.getServer().serverId, "build.prepare", plan, 30_000);
      }
      const approval = store.approve(decision as "approved" | "rejected" | "changes_requested", authActor(response), String(comment).slice(0, 2_000), Number(planVersion));
      if (decision === "approved") {
        try {
          await sendBridgeCommand(store.getServer().serverId, "build.start", { buildId: store.getJob().buildId, planVersion: Number(planVersion) }, 20_000);
        } catch (error) {
          store.markStartDispatchUnconfirmed(error instanceof Error ? error.message : "Paper Bridge 시작 확인 실패");
          throw error;
        }
      }
      response.status(201).json(api({ approval, job: store.getJob() }, "승인 결정을 기록했습니다.", "APPROVAL_RECORDED"));
    } catch (error) {
      next(error);
    }
  });

  for (const action of ["pause", "resume", "cancel", "rollback"] as const) {
    app.post(`/api/v1/builds/:buildId/${action}`, auth.requireRole("Operator"), (request, response, next) => {
      void (async () => {
        try {
          await sendBridgeCommand(store.getServer().serverId, action === "cancel" ? "build.rollback" : `build.${action}`, { buildId: store.getJob().buildId }, 20_000);
          const job = store.control(action, authActor(response));
          response.status(202).json(api(job, `${action} 요청을 접수했습니다.`, "COMMAND_ACCEPTED"));
        } catch (error) {
          next(error);
        }
      })();
    });
  }

  const webDist = fileURLToPath(new URL("../../../apps/web-control-center/dist", import.meta.url));
  const webIndex = fileURLToPath(new URL("../../../apps/web-control-center/dist/index.html", import.meta.url));
  if (existsSync(webIndex)) {
    app.use(express.static(webDist, { index: false, maxAge: "1h" }));
    app.use((request, response, next) => {
      if (request.method === "GET" && request.accepts("html") && !request.path.startsWith("/api/") && request.path !== "/health") {
        response.sendFile(webIndex);
        return;
      }
      next();
    });
  }

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const parserError = error as { type?: string };
    if (error instanceof SyntaxError && parserError.type === "entity.parse.failed") {
      response.status(400).json({ ok: false, code: "INVALID_JSON", message: "요청 JSON 형식이 올바르지 않습니다.", data: null, retryable: false });
      return;
    }
    if (parserError.type === "entity.too.large") {
      response.status(413).json({ ok: false, code: "PAYLOAD_TOO_LARGE", message: "요청 본문이 허용 크기를 초과했습니다.", data: null, retryable: false });
      return;
    }
    if (error instanceof ArchitectError) {
      response.status(error.statusCode).json({ ok: false, code: error.code, message: error.message, data: null, retryable: error.statusCode >= 429 });
      return;
    }
    if (error instanceof OpenAiKeyStoreError) {
      response.status(error.statusCode).json({ ok: false, code: error.code, message: error.message, data: null, retryable: false });
      return;
    }
    if (error instanceof BridgeCommandError) {
      response.status(error.statusCode).json({ ok: false, code: error.code, message: error.message, data: null, retryable: error.statusCode >= 500 });
      return;
    }
    if (error instanceof StoreError) {
      response.status(error.status).json({ ok: false, code: error.code, message: error.message, data: null, retryable: false });
      return;
    }
    console.error(error);
    response.status(500).json({ ok: false, code: "INTERNAL_ERROR", message: "Gateway 내부 오류가 발생했습니다.", data: null, retryable: true });
  });

  httpServer.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === "/events") {
      if (!auth.readCookieHeader(request.headers.cookie ?? "")) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      eventWss.handleUpgrade(request, socket, head, (client) => eventWss.emit("connection", client, request));
      return;
    }
    if (url.pathname === "/bridge") {
      const bridgeSecret = process.env.BRIDGE_SHARED_SECRET?.trim();
      const supplied = request.headers.authorization?.startsWith("Bearer ") ? request.headers.authorization.slice(7) : "";
      if (!bridgeSecret || !safeSecretEqual(bridgeSecret, supplied)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      bridgeWss.handleUpgrade(request, socket, head, (client) => bridgeWss.emit("connection", client, request));
      return;
    }
    socket.destroy();
  });

  eventWss.on("connection", (client, request) => {
    eventClientCookies.set(client, request.headers.cookie ?? "");
    client.once("close", () => eventClientCookies.delete(client));
    const url = new URL(request.url ?? "/events", "http://localhost");
    const after = Number(url.searchParams.get("afterSequence") ?? 0);
    for (const event of store.getEvents(after)) {
      const envelope: EventEnvelope<WsEventPayload> = {
        protocolVersion: 1,
        type: "event",
        messageId: `msg_${crypto.randomUUID()}`,
        serverId: store.getServer().serverId,
        buildId: store.getJob().buildId,
        sequence: event.sequence,
        timestamp: event.timestamp,
        payload: { event, job: store.getJob(), server: store.getServer() },
      };
      client.send(JSON.stringify(envelope));
    }
  });

  bridgeWss.on("connection", (client) => {
    client.send(JSON.stringify({ type: "bridge.welcome", protocolVersion: 1, heartbeatSeconds: 15 }));
    client.on("message", (raw) => {
      try {
        const message = JSON.parse(raw.toString()) as {
          messageId?: string;
          correlationId?: string;
          type?: string;
          serverId?: string;
          payload?: { ok?: boolean; code?: string; message?: string; data?: unknown } & Record<string, unknown>;
        };
        if (message.type === "bridge.register") {
          const serverId = message.serverId ?? store.getServer().serverId;
          if (serverId !== store.getServer().serverId) {
            client.close(1008, "server id not allowed");
            return;
          }
          const previous = bridgeClientsByServerId.get(serverId);
          if (previous && previous !== client) previous.close(1008, "replaced by a newer bridge connection");
          bridgeServerIds.set(client, serverId);
          bridgeClientsByServerId.set(serverId, client);
          store.setBridgeConnected(true);
          requestBridgeStatus(client, serverId);
          const existing = bridgePollers.get(client);
          if (existing) clearInterval(existing);
          const poller = setInterval(() => requestBridgeStatus(client, serverId), 5_000);
          poller.unref();
          bridgePollers.set(client, poller);
          return;
        }
        const registeredServerId = bridgeServerIds.get(client);
        if (!registeredServerId || message.serverId !== registeredServerId) {
          client.close(1008, "bridge must register a matching server id first");
          return;
        }
        if (message.type === "response" && message.correlationId) {
          const pending = pendingBridgeCommands.get(message.correlationId);
          if (pending) {
            clearTimeout(pending.timeout);
            pendingBridgeCommands.delete(message.correlationId);
            if (message.payload?.ok) pending.resolve(message.payload.data);
            else pending.reject(new BridgeCommandError(String(message.payload?.code ?? "BRIDGE_COMMAND_FAILED"), String(message.payload?.message ?? "Paper Bridge 명령이 거부되었습니다."), 409));
            return;
          }
        }
        if (message.type === "response" && message.payload?.ok && message.payload.data && typeof message.payload.data === "object") {
          store.updateServerHealth(message.payload.data as { version?: string; tps?: number; mspt?: number; playersOnline?: number; memoryUsedMb?: number; memoryTotalMb?: number; worlds?: string[]; build?: import("./store.js").BridgeExecutionStatus });
          return;
        }
        if (message.type === "event" && message.payload) {
          store.applyBridgeBuildEvent(message.payload as unknown as import("./store.js").BridgeBuildEvent);
        }
      } catch {
        client.send(JSON.stringify({ type: "response", ok: false, code: "INVALID_JSON" }));
      }
    });
    client.on("close", () => {
      const poller = bridgePollers.get(client);
      if (poller) clearInterval(poller);
      bridgePollers.delete(client);
      const serverId = bridgeServerIds.get(client);
      bridgeServerIds.delete(client);
      if (serverId && bridgeClientsByServerId.get(serverId) === client) bridgeClientsByServerId.delete(serverId);
      if (serverId) {
        for (const [messageId, pending] of pendingBridgeCommands) {
          if (pending.serverId !== serverId) continue;
          clearTimeout(pending.timeout);
          pendingBridgeCommands.delete(messageId);
          pending.reject(new BridgeCommandError("BRIDGE_DISCONNECTED", "명령 처리 중 Paper Bridge 연결이 끊겼습니다.", 503));
        }
      }
      if (bridgeServerIds.size === 0) store.setBridgeConnected(false);
    });
  });

  const broadcast = (payload: WsEventPayload) => {
    const envelope: EventEnvelope<WsEventPayload> = {
      protocolVersion: 1,
      type: "event",
      messageId: `msg_${crypto.randomUUID()}`,
      serverId: payload.server.serverId,
      buildId: payload.job.buildId,
      sequence: payload.event.sequence,
      timestamp: payload.event.timestamp,
      payload,
    };
    const json = JSON.stringify(envelope);
    for (const client of eventWss.clients) {
      const cookie = eventClientCookies.get(client) ?? "";
      if (!auth.readCookieHeader(cookie)) {
        client.close(1008, "session expired");
      } else if (client.readyState === WebSocket.OPEN) {
        client.send(json);
      }
    }
  };
  store.on("event", broadcast);

  const close = async () => {
    store.off("event", broadcast);
    await store.close();
    for (const poller of bridgePollers.values()) clearInterval(poller);
    bridgePollers.clear();
    for (const pending of pendingBridgeCommands.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new BridgeCommandError("GATEWAY_CLOSING", "Gateway가 종료 중입니다.", 503));
    }
    pendingBridgeCommands.clear();
    for (const client of eventWss.clients) client.close();
    for (const client of bridgeWss.clients) client.close();
    await Promise.all([
      new Promise<void>((resolve) => eventWss.close(() => resolve())),
      new Promise<void>((resolve) => bridgeWss.close(() => resolve())),
      closeHttpServer(httpServer),
    ]);
  };

  return { app, httpServer, store, close };
}

class BridgeCommandError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
  }
}

function enforceWindowRateLimit(key: string, requests: Map<string, number[]>, limit: number, windowMs: number) {
  const now = Date.now();
  if (requests.size > 10_000) {
    for (const [bucketKey, timestamps] of requests) {
      if (!timestamps.some((timestamp) => timestamp > now - windowMs)) requests.delete(bucketKey);
    }
  }
  const recent = (requests.get(key) ?? []).filter((timestamp) => timestamp > now - windowMs);
  if (recent.length >= limit) {
    requests.set(key, recent);
    return false;
  }
  recent.push(now);
  requests.set(key, recent);
  return true;
}

function safeSecretEqual(expected: string, supplied: string) {
  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(supplied, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

function enforceArchitectRateLimit(request: Request, buckets: Map<string, number[]>) {
  const now = Date.now();
  const windowMs = 60 * 60 * 1_000;
  const limit = Math.max(1, Number(process.env.ARCHITECT_RATE_LIMIT_PER_HOUR ?? 12));
  const key = clientAddress(request);
  const recent = (buckets.get(key) ?? []).filter((time) => time > now - windowMs);
  if (recent.length >= limit) {
    throw new ArchitectError("ARCHITECT_RATE_LIMITED", "시간당 AI 설계 요청 한도에 도달했습니다. 잠시 뒤 다시 시도해 주세요.", 429);
  }
  recent.push(now);
  buckets.set(key, recent);
}

function clientAddress(request: Request) {
  const remote = normalizeAddress(request.socket.remoteAddress ?? "unknown");
  const trustedProxyIps = new Set(
    (process.env.TRUSTED_PROXY_IPS ?? "127.0.0.1,::1,10.50.0.1")
      .split(",")
      .map((value) => normalizeAddress(value.trim()))
      .filter(Boolean),
  );
  if (trustedProxyIps.has(remote)) {
    const forwarded = request.header("cf-connecting-ip") ?? request.header("x-forwarded-for")?.split(",")[0]?.trim();
    if (forwarded && isIP(forwarded)) return forwarded;
  }
  return remote;
}

function normalizeAddress(value: string) {
  return value.startsWith("::ffff:") ? value.slice(7) : value;
}

function requestBridgeStatus(client: WebSocket, serverId: string) {
  if (client.readyState !== WebSocket.OPEN) return;
  client.send(JSON.stringify({
    protocolVersion: 1,
    type: "command",
    messageId: `msg_${crypto.randomUUID()}`,
    serverId,
    sequence: 0,
    timestamp: new Date().toISOString(),
    method: "server.get_status",
    payload: {},
  }));
}

function closeHttpServer(server: Server) {
  return new Promise<void>((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
