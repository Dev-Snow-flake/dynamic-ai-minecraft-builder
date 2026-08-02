import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionAuth } from "../src/auth.js";
import { OpenAiKeyStore } from "../src/openai-key-store.js";
import { createGateway } from "../src/server.js";
import { ControlCenterStore } from "../src/store.js";

test("requires a session and CSRF token for state-changing API calls", async () => {
  const password = "test-control-password-1234";
  const gateway = createGateway(new ControlCenterStore(null), undefined, new SessionAuth(password, false));
  gateway.httpServer.listen(0, "127.0.0.1");
  await once(gateway.httpServer, "listening");
  const address = gateway.httpServer.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;

  const login = await fetch(`${base}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  const loginBody = await login.json() as { data: { csrfToken: string } };
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie);

  const withoutCsrf = await fetch(`${base}/api/v1/builds/build_01JMF6RIVER/approvals`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ decision: "rejected", planVersion: 3 }),
  });
  assert.equal(withoutCsrf.status, 403);
  assert.equal((await withoutCsrf.json() as { code: string }).code, "CSRF_FAILED");

  const withCsrf = await fetch(`${base}/api/v1/builds/build_01JMF6RIVER/approvals`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, "x-csrf-token": loginBody.data.csrfToken },
    body: JSON.stringify({ decision: "rejected", planVersion: 3 }),
  });
  assert.equal(withCsrf.status, 201);
  await gateway.close();
});

test("enforces server-side roles instead of trusting browser headers", async () => {
  const viewerPassword = "viewer-password-for-unit-tests";
  const gateway = createGateway(
    new ControlCenterStore(null),
    undefined,
    new SessionAuth({ Viewer: viewerPassword, Admin: "admin-password-for-unit-tests" }, false),
  );
  gateway.httpServer.listen(0, "127.0.0.1");
  await once(gateway.httpServer, "listening");
  const address = gateway.httpServer.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const login = await fetch(`${base}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: viewerPassword }),
  });
  const body = await login.json() as { data: { csrfToken: string; role: string } };
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie);
  assert.equal(body.data.role, "Viewer");

  const response = await fetch(`${base}/api/v1/architect/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie,
      "x-csrf-token": body.data.csrfToken,
      "x-role": "Admin",
    },
    body: JSON.stringify({ message: "권한 우회", target: { world: "world", origin: { x: 0, y: 80, z: 0 } } }),
  });
  assert.equal(response.status, 403);
  assert.equal((await response.json() as { code: string }).code, "FORBIDDEN");
  await gateway.close();
});

test("stores an OpenAI key encrypted at rest and can delete it", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dynamic-ai-key-store-"));
  const target = path.join(directory, "openai-key.json");
  const secret = "unit-test-encryption-secret-with-enough-entropy";
  const apiKey = ["sk", "proj", "unit-test-key-that-is-never-real"].join("-");
  const store = new OpenAiKeyStore(target, secret);
  try {
    await store.write(apiKey);
    const file = await readFile(target, "utf8");
    assert.equal(file.includes(apiKey), false);
    assert.deepEqual(await store.read(), { key: apiKey, source: "encrypted-store" });
    await store.clear();
    assert.deepEqual(await store.read(), { key: null, source: "none" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("restores a generated executable blueprint after a Gateway restart", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dynamic-ai-state-"));
  const target = path.join(directory, "control-center-state.json");
  try {
    const first = new ControlCenterStore(target);
    first.publishAiDesign({
      title: "복구 테스트",
      intent: "재시작 후에도 실행 계획을 유지한다",
      dimensions: { x: 5, y: 3, z: 5 },
      runs: [{ y: 0, z: 0, xStart: 0, xEnd: 4, material: "stone_brick" }],
      risks: [],
    }, "복구 테스트", "test-model", { world: "world", origin: { x: 32, y: 80, z: -16 } });
    await first.close();

    const second = new ControlCenterStore(target);
    assert.equal(second.getJob().title, "복구 테스트");
    assert.equal(second.getJob().executionReady, true);
    assert.equal(second.getSiteSnapshot().origin.x, 32);
    await second.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
