import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { WebSocket } from "ws";
import type { ArchitectService } from "../src/architect.js";
import { SessionAuth } from "../src/auth.js";
import { createGateway } from "../src/server.js";
import { ControlCenterStore } from "../src/store.js";

const TEST_PASSWORD = "test-control-password-1234";

async function login(base: string) {
  const response = await fetch(`${base}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: TEST_PASSWORD }),
  });
  assert.equal(response.status, 200);
  const body = await response.json() as { data: { csrfToken: string } };
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie);
  return { cookie, csrfToken: body.data.csrfToken };
}

function authHeaders(auth: Awaited<ReturnType<typeof login>>) {
  return {
    "content-type": "application/json",
    cookie: auth.cookie,
    "x-csrf-token": auth.csrfToken,
  };
}

test("returns the initial build and enforces approval version", async () => {
  const gateway = createGateway(new ControlCenterStore(null), undefined, new SessionAuth(TEST_PASSWORD, false));
  gateway.httpServer.listen(0, "127.0.0.1");
  await once(gateway.httpServer, "listening");
  const address = gateway.httpServer.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const auth = await login(base);

  const buildResponse = await fetch(`${base}/api/v1/builds/build_01JMF6RIVER`, { headers: { cookie: auth.cookie } });
  assert.equal(buildResponse.status, 200);
  const buildBody = await buildResponse.json() as { data: { status: string; blueprint: { planVersion: number } } };
  assert.equal(buildBody.data.status, "WAITING_APPROVAL");
  assert.equal(buildBody.data.blueprint.planVersion, 3);

  const approvalResponse = await fetch(`${base}/api/v1/builds/build_01JMF6RIVER/approvals`, {
    method: "POST",
    headers: authHeaders(auth),
    body: JSON.stringify({ decision: "approved", planVersion: 2 }),
  });
  assert.equal(approvalResponse.status, 409);
  const approvalBody = await approvalResponse.json() as { code: string };
  assert.equal(approvalBody.code, "PLAN_VERSION_MISMATCH");

  await gateway.close();
});

test("rejects unauthenticated control commands", async () => {
  const gateway = createGateway(new ControlCenterStore(null), undefined, new SessionAuth(TEST_PASSWORD, false));
  gateway.httpServer.listen(0, "127.0.0.1");
  await once(gateway.httpServer, "listening");
  const address = gateway.httpServer.address();
  assert.ok(address && typeof address === "object");
  const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/builds/build_01JMF6RIVER/pause`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(response.status, 401);
  await gateway.close();
});

test("returns a client error for malformed JSON", async () => {
  const gateway = createGateway(new ControlCenterStore(null), undefined, new SessionAuth(TEST_PASSWORD, false));
  gateway.httpServer.listen(0, "127.0.0.1");
  await once(gateway.httpServer, "listening");
  const address = gateway.httpServer.address();
  assert.ok(address && typeof address === "object");
  const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/architect/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{invalid",
  });
  assert.equal(response.status, 400);
  const body = await response.json() as { code: string };
  assert.equal(body.code, "INVALID_JSON");
  await gateway.close();
});

test("registers a Paper bridge and applies live server health", async () => {
  process.env.BRIDGE_SHARED_SECRET = "test-bridge-secret";
  const gateway = createGateway(new ControlCenterStore(null), undefined, new SessionAuth(TEST_PASSWORD, false));
  gateway.httpServer.listen(0, "127.0.0.1");
  await once(gateway.httpServer, "listening");
  const address = gateway.httpServer.address();
  assert.ok(address && typeof address === "object");

  const bridge = new WebSocket(`ws://127.0.0.1:${address.port}/bridge`, {
    headers: { Authorization: "Bearer test-bridge-secret" },
  });
  await once(bridge, "open");
  const commandPromise = new Promise<Record<string, unknown>>((resolve) => {
    const onMessage = (raw: WebSocket.RawData) => {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (message.type === "command") {
        bridge.off("message", onMessage);
        resolve(message);
      }
    };
    bridge.on("message", onMessage);
  });
  bridge.send(JSON.stringify({ type: "bridge.register", messageId: "register_1", serverId: "server_main" }));
  const command = await commandPromise;
  assert.equal(command.method, "server.get_status");

  const healthPromise = new Promise<void>((resolve) => {
    const onEvent = (payload: { event: { type: string } }) => {
      if (payload.event.type === "server.health.updated") {
        gateway.store.off("event", onEvent);
        resolve();
      }
    };
    gateway.store.on("event", onEvent);
  });
  bridge.send(JSON.stringify({
    type: "response",
    serverId: "server_main",
    correlationId: command.messageId,
    payload: {
      ok: true,
      data: { version: "Paper test", tps: 19.95, mspt: 11.4, playersOnline: 2, worlds: ["world"] },
    },
  }));
  await healthPromise;
  assert.equal(gateway.store.getServer().connected, true);
  assert.equal(gateway.store.getServer().tps, 19.95);
  assert.equal(gateway.store.getServer().playersOnline, 2);

  bridge.close();
  await once(bridge, "close");
  await gateway.close();
  delete process.env.BRIDGE_SHARED_SECRET;
});

test("publishes an image-guided AI design as a new approval-only blueprint", async () => {
  let receivedInput: unknown;
  const architect: ArchitectService = {
    status: () => ({ configured: true, model: "test-model" }),
    generate: async (input) => {
      receivedInput = input;
      return {
        model: "test-model",
        assistantMessage: "참고 이미지의 실루엣을 반영한 소형 건물 청사진을 만들었습니다.",
        design: {
          title: "이미지 기반 소형 건물",
          intent: "짙은 목재와 석재 기단을 사용한 소형 건물",
          dimensions: { x: 5, y: 3, z: 5 },
          runs: [
            { y: 0, z: 0, xStart: 0, xEnd: 4, material: "stone_brick" },
            { y: 1, z: 0, xStart: 0, xEnd: 4, material: "spruce" },
          ],
          risks: [{ label: "출입구", detail: "승인 전에 출입구 방향을 확인하세요.", severity: "info" }],
        },
      };
    },
  };
  const gateway = createGateway(new ControlCenterStore(null), architect, new SessionAuth(TEST_PASSWORD, false));
  gateway.httpServer.listen(0, "127.0.0.1");
  await once(gateway.httpServer, "listening");
  const address = gateway.httpServer.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const auth = await login(base);

  const statusResponse = await fetch(`${base}/api/v1/architect/status`, { headers: { cookie: auth.cookie } });
  const statusBody = await statusResponse.json() as { data: { configured: boolean; model: string } };
  assert.equal(statusBody.data.configured, true);
  assert.equal(statusBody.data.model, "test-model");

  const response = await fetch(`${base}/api/v1/architect/messages`, {
    method: "POST",
    headers: authHeaders(auth),
    body: JSON.stringify({
      message: "이 이미지를 작은 집으로 설계해줘",
      imageDataUrl: "data:image/png;base64,iVBORw0KGgo=",
      target: { world: "world", origin: { x: 10, y: 80, z: 20 } },
    }),
  });
  assert.equal(response.status, 200);
  const body = await response.json() as { data: { job: { status: string; blueprint: { planVersion: number; placedBlocks: number } }; snapshot: { blueprint: unknown[] } } };
  assert.equal(body.data.job.status, "WAITING_APPROVAL");
  assert.equal(body.data.job.blueprint.planVersion, 4);
  assert.equal(body.data.job.blueprint.placedBlocks, 10);
  assert.equal(body.data.snapshot.blueprint.length, 10);
  assert.deepEqual(receivedInput, {
    message: "이 이미지를 작은 집으로 설계해줘",
    imageDataUrl: "data:image/png;base64,iVBORw0KGgo=",
    target: { world: "world", origin: { x: 10, y: 80, z: 20 } },
  });

  await gateway.close();
});

test("prepares and persists an approved blueprint before Paper starts writing", async () => {
  process.env.BRIDGE_SHARED_SECRET = "test-bridge-secret";
  const architect: ArchitectService = {
    status: () => ({ configured: true, model: "test-model", source: "none" }),
    generate: async () => ({
      model: "test-model",
      assistantMessage: "실행 가능한 시험 청사진을 만들었습니다.",
      design: {
        title: "2단계 승인 시험",
        intent: "승인이 영속화된 뒤에만 월드를 변경합니다.",
        dimensions: { x: 5, y: 3, z: 5 },
        runs: [{ y: 0, z: 0, xStart: 0, xEnd: 4, material: "stone_brick" }],
        risks: [],
      },
    }),
  };
  const gateway = createGateway(new ControlCenterStore(null), architect, new SessionAuth(TEST_PASSWORD, false));
  gateway.httpServer.listen(0, "127.0.0.1");
  await once(gateway.httpServer, "listening");
  const address = gateway.httpServer.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const auth = await login(base);

  const bridge = new WebSocket(`ws://127.0.0.1:${address.port}/bridge`, {
    headers: { Authorization: "Bearer test-bridge-secret" },
  });
  await once(bridge, "open");
  const methods: string[] = [];
  bridge.on("message", (raw) => {
    const message = JSON.parse(raw.toString()) as { type?: string; method?: string; messageId?: string };
    if (message.type !== "command" || !message.messageId) return;
    if (message.method) methods.push(message.method);
    bridge.send(JSON.stringify({
      type: "response",
      serverId: "server_main",
      correlationId: message.messageId,
      payload: {
        ok: true,
        data: message.method === "server.get_status"
          ? { version: "Paper test", tps: 20, mspt: 10, playersOnline: 0, worlds: ["world"] }
          : { state: message.method === "build.prepare" ? "PAUSED" : "RUNNING" },
      },
    }));
  });
  bridge.send(JSON.stringify({ type: "bridge.register", messageId: "register_approval", serverId: "server_main" }));
  await new Promise<void>((resolve) => {
    const onEvent = (payload: { event: { type: string } }) => {
      if (payload.event.type !== "server.health.updated") return;
      gateway.store.off("event", onEvent);
      resolve();
    };
    gateway.store.on("event", onEvent);
  });

  const designResponse = await fetch(`${base}/api/v1/architect/messages`, {
    method: "POST",
    headers: authHeaders(auth),
    body: JSON.stringify({ message: "시험 건물을 만들어줘", target: { world: "world", origin: { x: 0, y: 80, z: 0 } } }),
  });
  assert.equal(designResponse.status, 200);
  const design = await designResponse.json() as { data: { job: { blueprint: { planVersion: number } } } };

  const approvalResponse = await fetch(`${base}/api/v1/builds/build_01JMF6RIVER/approvals`, {
    method: "POST",
    headers: authHeaders(auth),
    body: JSON.stringify({ decision: "approved", planVersion: design.data.job.blueprint.planVersion }),
  });
  assert.equal(approvalResponse.status, 201);
  assert.deepEqual(methods.filter((method) => method.startsWith("build.")), ["build.prepare", "build.start"]);
  assert.equal(gateway.store.getJob().status, "BUILDING");

  bridge.close();
  await once(bridge, "close");
  await gateway.close();
  delete process.env.BRIDGE_SHARED_SECRET;
});
