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
import { TenantContexts, type TenantContext } from "./tenant-contexts.js";
import { TenantRegistry, TenantRegistryError } from "./tenant-registry.js";

function api<T>(data: T, message = "ok", code = "OK"): ApiResponse<T> {
  return { ok: true, code, message, data, retryable: false };
}

export function createGateway(
  store = new ControlCenterStore(),
  architect: ArchitectService = new OpenAiArchitectService(),
  auth = new SessionAuth(),
  tenantRegistry = new TenantRegistry(),
) {
  const app = express();
  const httpServer = createServer(app);
  const eventWss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const bridgeWss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
  const bridgePollers = new Map<WebSocket, NodeJS.Timeout>();
  const bridgeServerIds = new Map<WebSocket, string>();
  const bridgeAuthorizedServerIds = new Map<WebSocket, string>();
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
  const enrollmentRequests = new Map<string, number[]>();
  const worldMapCache = new Map<string, { expiresAt: number; data: unknown }>();
  const contexts = new TenantContexts(store, architect);
  const attachedStores = new Set<ControlCenterStore>();
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

  function ensureContext(serverId: string): TenantContext {
    const context = serverId === "server_main"
      ? contexts.getDefault()
      : (() => {
          const tenant = tenantRegistry.get(serverId);
          if (!tenant) throw new TenantRegistryError("SERVER_NOT_FOUND", "등록된 서버를 찾을 수 없습니다.", 404);
          return contexts.getOrCreate(tenant);
        })();
    if (!attachedStores.has(context.store)) {
      context.store.on("event", broadcast);
      attachedStores.add(context.store);
    }
    return context;
  }

  function responseContext(response: Response) {
    const context = response.locals.tenantContext as TenantContext | undefined;
    if (!context) throw new TenantRegistryError("SERVER_CONTEXT_MISSING", "서버 컨텍스트를 확인할 수 없습니다.", 500);
    return context;
  }

  function requireMatchingResources(request: Request, response: Response, next: NextFunction) {
    const context = responseContext(response);
    if (request.params.serverId && request.params.serverId !== context.serverId) {
      response.status(404).json({ ok: false, code: "RESOURCE_NOT_FOUND", message: "이 세션에서 해당 서버를 찾을 수 없습니다.", data: null, retryable: false });
      return;
    }
    if (request.params.buildId && request.params.buildId !== context.store.getJob().buildId) {
      response.status(404).json({ ok: false, code: "RESOURCE_NOT_FOUND", message: "이 세션에서 해당 작업을 찾을 수 없습니다.", data: null, retryable: false });
      return;
    }
    next();
  }
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

  app.post("/api/v1/public/servers/enroll", async (request, response, next) => {
    try {
      if (process.env.ALLOW_PUBLIC_SERVER_ENROLLMENT !== "true") {
        response.status(404).json({ ok: false, code: "ENROLLMENT_DISABLED", message: "공개 서버 등록이 비활성화되어 있습니다.", data: null, retryable: false });
        return;
      }
      if (!enforceWindowRateLimit(clientAddress(request), enrollmentRequests, 5, 60 * 60 * 1_000)) {
        response.status(429).json({ ok: false, code: "ENROLLMENT_RATE_LIMITED", message: "이 주소에서 너무 많은 등록을 요청했습니다. 잠시 후 다시 시도하세요.", data: null, retryable: true });
        return;
      }
      const enrollment = await tenantRegistry.enroll(request.body ?? {});
      response.status(201).json(api({
        ...enrollment,
        claimUrl: `https://map.work-plus.kr/claim?serverId=${encodeURIComponent(enrollment.serverId)}`,
      }, "서버가 등록되었습니다. 30분 안에 소유권 코드를 입력하세요.", "SERVER_ENROLLED"));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/v1/public/servers/claim", async (request, response, next) => {
    try {
      if (process.env.ALLOW_PUBLIC_SERVER_ENROLLMENT !== "true") {
        response.status(404).json({ ok: false, code: "ENROLLMENT_DISABLED", message: "공개 서버 등록이 비활성화되어 있습니다.", data: null, retryable: false });
        return;
      }
      if (!enforceWindowRateLimit(clientAddress(request), loginRequests, 10, 15 * 60 * 1_000)) {
        response.status(429).json({ ok: false, code: "CLAIM_RATE_LIMITED", message: "소유권 확인 시도가 너무 많습니다. 잠시 후 다시 시도하세요.", data: null, retryable: true });
        return;
      }
      const tenant = await tenantRegistry.claim(request.body?.serverId, request.body?.claimCode, request.body?.password, request.body?.displayName);
      const session = auth.createSession("Admin", `${tenant.displayName} 관리자`, tenant.serverId, true);
      ensureContext(tenant.serverId);
      auth.setCookie(response, session);
      response.status(201).json(api(auth.publicSession(session), "서버 소유권 등록이 완료되었습니다.", "SERVER_CLAIMED"));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/v1/auth/login", async (request, response, next) => {
    const requestedServerId = typeof request.body?.serverId === "string" ? request.body.serverId.trim() : "server_main";
    if (requestedServerId === "server_main" && !auth.configured) {
      response.status(503).json({ ok: false, code: "AUTH_NOT_CONFIGURED", message: "서버 관리자 비밀번호가 설정되지 않았습니다.", data: null, retryable: false });
      return;
    }
    if (!enforceWindowRateLimit(clientAddress(request), loginRequests, 10, 15 * 60 * 1_000)) {
      response.status(429).json({ ok: false, code: "LOGIN_RATE_LIMITED", message: "로그인 시도가 너무 많습니다. 잠시 뒤 다시 시도해 주세요.", data: null, retryable: true });
      return;
    }
    try {
      const tenant = requestedServerId === "server_main"
        ? null
        : await tenantRegistry.authenticate(requestedServerId, request.body?.password);
      const session = requestedServerId === "server_main"
        ? auth.login(request.body?.password, "server_main")
        : tenant && auth.createSession("Admin", `${tenant.displayName} 관리자`, tenant.serverId, true);
      if (!session) {
        response.status(401).json({ ok: false, code: "INVALID_CREDENTIALS", message: "서버 ID 또는 관리자 비밀번호가 올바르지 않습니다.", data: null, retryable: false });
        return;
      }
      ensureContext(session.serverId);
      auth.setCookie(response, session);
      response.json(api(auth.publicSession(session), "로그인했습니다.", "AUTHENTICATED"));
    } catch (error) {
      next(error);
    }
  });
  app.get("/api/v1/auth/session", auth.requireSession, (_request, response) => {
    response.json(api(auth.publicSession(response.locals.authSession), "인증된 세션입니다.", "AUTHENTICATED"));
  });
  app.post("/api/v1/auth/logout", auth.requireSession, auth.requireCsrf, (request, response) => {
    auth.logout(request);
    auth.clearCookie(response);
    response.json(api({ authenticated: false }, "로그아웃했습니다.", "SIGNED_OUT"));
  });

  app.use("/api/v1", auth.requireSession, auth.requireCsrf, (_request, response, next) => {
    try {
      response.locals.tenantContext = ensureContext(response.locals.authSession.serverId);
      next();
    } catch (error) {
      next(error);
    }
  });
  app.get("/api/v1/servers", (_request, response) => response.json(api([responseContext(response).store.getServer()])));
  app.get("/api/v1/servers/:serverId/status", requireMatchingResources, (_request, response) => response.json(api(responseContext(response).store.getServer())));
  app.get("/api/v1/builds", (_request, response) => response.json(api(responseContext(response).store.getJobs())));
  app.get("/api/v1/builds/:buildId", requireMatchingResources, (_request, response) => response.json(api(responseContext(response).store.getJob())));
  app.get("/api/v1/builds/:buildId/blueprints/:version", requireMatchingResources, (_request, response) => response.json(api(responseContext(response).store.getJob().blueprint)));
  app.get("/api/v1/builds/:buildId/events", (request, response) => {
    if (request.params.buildId !== responseContext(response).store.getJob().buildId) {
      response.status(404).json({ ok: false, code: "RESOURCE_NOT_FOUND", message: "이 세션에서 해당 작업을 찾을 수 없습니다.", data: null, retryable: false });
      return;
    }
    const after = Number(request.query.after ?? 0);
    response.json(api(responseContext(response).store.getEvents(Number.isFinite(after) ? after : 0)));
  });
  app.get("/api/v1/builds/:buildId/site-snapshot", requireMatchingResources, (_request, response) => response.json(api(responseContext(response).store.getSiteSnapshot())));
  app.get("/api/v1/audit-events", (_request, response) => response.json(api(responseContext(response).store.getAuditEvents())));
  app.get("/api/v1/architect/status", (_request, response) => response.json(api(responseContext(response).architect.status())));

  app.get("/api/v1/world-map", async (_request, response, next) => {
    try {
      const context = responseContext(response);
      if (!context.hostedTenant) {
        response.json(api({ mode: "bluemap", url: "/live-map/" }));
        return;
      }
      const cached = worldMapCache.get(context.serverId);
      if (cached && cached.expiresAt > Date.now()) {
        response.json(api({ mode: "plugin", snapshot: cached.data }));
        return;
      }
      const snapshot = validateWorldMapSnapshot(await sendBridgeCommand(context.serverId, "world.get_map", {}, 20_000));
      worldMapCache.set(context.serverId, { expiresAt: Date.now() + 15_000, data: snapshot });
      response.json(api({ mode: "plugin", snapshot }));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/v1/settings/openai-key", auth.requireRole("Admin"), async (request, response, next) => {
    try {
      const architect = responseContext(response).architect;
      if (!architect.configureApiKey) throw new OpenAiKeyStoreError("OPENAI_KEY_STORE_NOT_SUPPORTED", "이 배포에서는 웹 키 저장을 지원하지 않습니다.", 503);
      const status = await architect.configureApiKey(String(request.body?.apiKey ?? ""));
      response.json(api(status, "OpenAI API 키를 암호화해 서버에 저장했습니다.", "OPENAI_KEY_SAVED"));
    } catch (error) {
      next(error);
    }
  });
  app.delete("/api/v1/settings/openai-key", auth.requireRole("Admin"), async (_request, response, next) => {
    try {
      const architect = responseContext(response).architect;
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
      const { architect, store } = responseContext(response);
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

  app.post("/api/v1/builds/:buildId/approvals", requireMatchingResources, auth.requireRole("Reviewer"), async (request, response, next) => {
    try {
      const store = responseContext(response).store;
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
    app.post(`/api/v1/builds/:buildId/${action}`, requireMatchingResources, auth.requireRole("Operator"), (request, response, next) => {
      void (async () => {
        try {
          const store = responseContext(response).store;
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
    if (error instanceof TenantRegistryError) {
      response.status(error.statusCode).json({ ok: false, code: error.code, message: error.message, data: null, retryable: error.statusCode >= 429 });
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
      const requestedServerHeader = request.headers["x-dynamic-ai-server-id"];
      const requestedServerId = Array.isArray(requestedServerHeader) ? requestedServerHeader[0] : requestedServerHeader;
      const defaultAuthorized = (!requestedServerId || requestedServerId === "server_main")
        && Boolean(bridgeSecret)
        && safeSecretEqual(bridgeSecret ?? "", supplied);
      const tenantAuthorized = requestedServerId ? tenantRegistry.authenticateBridge(requestedServerId, supplied) : null;
      const authorizedServerId = defaultAuthorized ? "server_main" : tenantAuthorized?.serverId;
      if (!authorizedServerId) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      bridgeWss.handleUpgrade(request, socket, head, (client) => {
        bridgeAuthorizedServerIds.set(client, authorizedServerId);
        bridgeWss.emit("connection", client, request);
      });
      return;
    }
    socket.destroy();
  });

  eventWss.on("connection", (client, request) => {
    eventClientCookies.set(client, request.headers.cookie ?? "");
    client.once("close", () => eventClientCookies.delete(client));
    const session = auth.readCookieHeader(request.headers.cookie ?? "");
    if (!session) {
      client.close(1008, "session expired");
      return;
    }
    const context = ensureContext(session.serverId);
    const store = context.store;
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
          const authorizedServerId = bridgeAuthorizedServerIds.get(client);
          const serverId = message.serverId ?? authorizedServerId;
          if (!authorizedServerId || serverId !== authorizedServerId) {
            client.close(1008, "server id not allowed");
            return;
          }
          const context = ensureContext(serverId);
          const previous = bridgeClientsByServerId.get(serverId);
          if (previous && previous !== client) previous.close(1008, "replaced by a newer bridge connection");
          bridgeServerIds.set(client, serverId);
          bridgeClientsByServerId.set(serverId, client);
          context.store.setBridgeConnected(true);
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
          if (pending && pending.serverId === registeredServerId) {
            clearTimeout(pending.timeout);
            pendingBridgeCommands.delete(message.correlationId);
            if (message.payload?.ok) pending.resolve(message.payload.data);
            else pending.reject(new BridgeCommandError(String(message.payload?.code ?? "BRIDGE_COMMAND_FAILED"), String(message.payload?.message ?? "Paper Bridge 명령이 거부되었습니다."), 409));
            return;
          }
        }
        if (message.type === "response" && message.payload?.ok && message.payload.data && typeof message.payload.data === "object") {
          ensureContext(registeredServerId).store.updateServerHealth(message.payload.data as { version?: string; tps?: number; mspt?: number; playersOnline?: number; memoryUsedMb?: number; memoryTotalMb?: number; worlds?: string[]; build?: import("./store.js").BridgeExecutionStatus });
          return;
        }
        if (message.type === "event" && message.payload) {
          ensureContext(registeredServerId).store.applyBridgeBuildEvent(message.payload as unknown as import("./store.js").BridgeBuildEvent);
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
      bridgeAuthorizedServerIds.delete(client);
      if (serverId && bridgeClientsByServerId.get(serverId) === client) bridgeClientsByServerId.delete(serverId);
      if (serverId) {
        for (const [messageId, pending] of pendingBridgeCommands) {
          if (pending.serverId !== serverId) continue;
          clearTimeout(pending.timeout);
          pendingBridgeCommands.delete(messageId);
          pending.reject(new BridgeCommandError("BRIDGE_DISCONNECTED", "명령 처리 중 Paper Bridge 연결이 끊겼습니다.", 503));
        }
      }
      if (serverId) ensureContext(serverId).store.setBridgeConnected(false);
    });
  });

  function broadcast(payload: WsEventPayload) {
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
      const session = auth.readCookieHeader(cookie);
      if (!session) {
        client.close(1008, "session expired");
      } else if (session.serverId === payload.server.serverId && client.readyState === WebSocket.OPEN) {
        client.send(json);
      }
    }
  }
  ensureContext("server_main");

  const close = async () => {
    for (const attachedStore of attachedStores) attachedStore.off("event", broadcast);
    await contexts.close();
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

function validateWorldMapSnapshot(value: unknown) {
  if (!value || typeof value !== "object") throw new BridgeCommandError("INVALID_WORLD_MAP", "Paper Bridge가 잘못된 월드 지도 데이터를 반환했습니다.", 502);
  const input = value as Record<string, unknown>;
  const world = typeof input.world === "string" ? input.world : "";
  const centerX = Number(input.centerX);
  const centerZ = Number(input.centerZ);
  const radius = Number(input.radius);
  const step = Number(input.step);
  const skippedUnloadedCells = Number(input.skippedUnloadedCells);
  const capturedAt = typeof input.capturedAt === "string" ? input.capturedAt : "";
  if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(world)
    || ![centerX, centerZ, radius, step, skippedUnloadedCells].every(Number.isInteger)
    || Math.abs(centerX) > 30_000_000 || Math.abs(centerZ) > 30_000_000
    || radius < 16 || radius > 128 || step < 4 || step > 8
    || skippedUnloadedCells < 0 || !Number.isFinite(Date.parse(capturedAt))
    || !Array.isArray(input.cells) || input.cells.length > 5_000) {
    throw new BridgeCommandError("INVALID_WORLD_MAP", "Paper Bridge 월드 지도 데이터가 안전 제한을 벗어났습니다.", 502);
  }
  const cells = input.cells.map((raw) => {
    if (!raw || typeof raw !== "object") throw new BridgeCommandError("INVALID_WORLD_MAP", "월드 지도 셀 형식이 올바르지 않습니다.", 502);
    const cell = raw as Record<string, unknown>;
    const x = Number(cell.x);
    const y = Number(cell.y);
    const z = Number(cell.z);
    const block = typeof cell.block === "string" ? cell.block : "";
    if (![x, y, z].every(Number.isInteger)
      || Math.abs(x - centerX) > radius || Math.abs(z - centerZ) > radius
      || y < -2048 || y > 2048 || !/^[a-z0-9_.-]+:[a-z0-9_./-]{1,128}$/.test(block)) {
      throw new BridgeCommandError("INVALID_WORLD_MAP", "월드 지도 셀이 안전 제한을 벗어났습니다.", 502);
    }
    return { x, y, z, block };
  });
  return { world, centerX, centerZ, radius, step, skippedUnloadedCells, capturedAt, cells };
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
