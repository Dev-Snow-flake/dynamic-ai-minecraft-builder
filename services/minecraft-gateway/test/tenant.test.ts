import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { SessionAuth } from "../src/auth.js";
import { createGateway } from "../src/server.js";
import { ControlCenterStore } from "../src/store.js";
import { TenantRegistry } from "../src/tenant-registry.js";

const token = (byte: number) => Buffer.alloc(32, byte).toString("base64url");

test("tenant registry stores only hashes and makes claim codes one-use", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dynamic-ai-tenants-"));
  const target = path.join(directory, "registry.json");
  const registry = new TenantRegistry(target);
  const bridgeToken = token(7);
  const password = "tenant-password-which-is-long";
  try {
    const enrolled = await registry.enroll({
      installationId: "11111111-1111-4111-8111-111111111111",
      bridgeToken,
      displayName: "Test Realm",
    });
    assert.match(enrolled.serverId, /^srv_[a-f0-9]{24}$/);
    assert.ok(enrolled.claimCode.length >= 20);
    await registry.claim(enrolled.serverId, enrolled.claimCode, password, "Claimed Realm");
    assert.equal((await registry.authenticate(enrolled.serverId, password))?.displayName, "Claimed Realm");
    await assert.rejects(
      registry.claim(enrolled.serverId, enrolled.claimCode, password),
      (error: { code?: string }) => error.code === "SERVER_ALREADY_CLAIMED",
    );
    const persisted = await readFile(target, "utf8");
    assert.equal(persisted.includes(bridgeToken), false);
    assert.equal(persisted.includes(enrolled.claimCode.replaceAll("-", "")), false);
    assert.equal(persisted.includes(password), false);

    const restored = new TenantRegistry(target);
    assert.equal((await restored.authenticate(enrolled.serverId, password))?.serverId, enrolled.serverId);
    assert.equal(restored.authenticateBridge(enrolled.serverId, bridgeToken)?.serverId, enrolled.serverId);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("hosted sessions, API keys, and bridge credentials remain tenant-scoped", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dynamic-ai-isolation-"));
  const registry = new TenantRegistry(path.join(directory, "registry.json"));
  const previous = {
    enrollment: process.env.ALLOW_PUBLIC_SERVER_ENROLLMENT,
    state: process.env.TENANT_STATE_DIRECTORY,
    keys: process.env.TENANT_KEY_DIRECTORY,
    encryption: process.env.OPENAI_KEY_ENCRYPTION_SECRET,
  };
  process.env.ALLOW_PUBLIC_SERVER_ENROLLMENT = "true";
  process.env.TENANT_STATE_DIRECTORY = path.join(directory, "states");
  process.env.TENANT_KEY_DIRECTORY = path.join(directory, "keys");
  process.env.OPENAI_KEY_ENCRYPTION_SECRET = "tenant-test-encryption-secret-with-entropy";
  const a = await registry.enroll({ installationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", bridgeToken: token(10), displayName: "Realm A" });
  const b = await registry.enroll({ installationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", bridgeToken: token(11), displayName: "Realm B" });
  const passwordA = "realm-a-password-long-enough";
  const passwordB = "realm-b-password-long-enough";
  await registry.claim(a.serverId, a.claimCode, passwordA);
  await registry.claim(b.serverId, b.claimCode, passwordB);
  const gateway = createGateway(new ControlCenterStore(null), undefined, new SessionAuth("default-admin-password-long", false), registry);
  try {
    gateway.httpServer.listen(0, "127.0.0.1");
    await once(gateway.httpServer, "listening");
    const address = gateway.httpServer.address();
    assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}`;

    const authA = await tenantLogin(base, a.serverId, passwordA);
    const own = await fetch(`${base}/api/v1/servers/${a.serverId}/status`, { headers: { cookie: authA.cookie } });
    assert.equal(own.status, 200);
    assert.equal((await own.json() as { data: { serverId: string } }).data.serverId, a.serverId);
    const crossed = await fetch(`${base}/api/v1/servers/${b.serverId}/status`, { headers: { cookie: authA.cookie } });
    assert.equal(crossed.status, 404);

    const fakeKeyA = "sk-proj-tenant-a-key-that-is-not-real";
    const saved = await fetch(`${base}/api/v1/settings/openai-key`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: authA.cookie, "x-csrf-token": authA.csrfToken },
      body: JSON.stringify({ apiKey: fakeKeyA }),
    });
    assert.equal(saved.status, 200);
    const encryptedA = await readFile(path.join(directory, "keys", `${a.serverId}.json`), "utf8");
    assert.equal(encryptedA.includes(fakeKeyA), false);
    await assert.rejects(readFile(path.join(directory, "keys", `${b.serverId}.json`), "utf8"));

    await expectRejectedBridge(`ws://127.0.0.1:${address.port}/bridge`, b.serverId, token(10));
    const bridge = new WebSocket(`ws://127.0.0.1:${address.port}/bridge`, {
      headers: { Authorization: `Bearer ${token(10)}`, "X-Dynamic-AI-Server-Id": a.serverId },
    });
    await once(bridge, "open");
    const commandPromise = nextCommand(bridge, "server.get_status");
    bridge.send(JSON.stringify({ type: "bridge.register", messageId: "tenant-register", serverId: a.serverId }));
    const command = await commandPromise;
    assert.equal(command.serverId, a.serverId);

    const mapCommandPromise = nextCommand(bridge, "world.get_map");
    const mapResponsePromise = fetch(`${base}/api/v1/world-map`, { headers: { cookie: authA.cookie } });
    const mapCommand = await mapCommandPromise;
    bridge.send(JSON.stringify({
      type: "response",
      serverId: a.serverId,
      correlationId: mapCommand.messageId,
      payload: {
        ok: true,
        data: {
          world: "world",
          centerX: 0,
          centerZ: 0,
          radius: 16,
          step: 4,
          skippedUnloadedCells: 0,
          capturedAt: new Date().toISOString(),
          cells: [{ x: 0, y: 64, z: 0, block: "minecraft:grass_block" }],
        },
      },
    }));
    const mapResponse = await mapResponsePromise;
    assert.equal(mapResponse.status, 200);
    const mapBody = await mapResponse.json() as { data: { mode: string; snapshot: { cells: unknown[] } } };
    assert.equal(mapBody.data.mode, "plugin");
    assert.equal(mapBody.data.snapshot.cells.length, 1);
    bridge.close();
    await once(bridge, "close");
  } finally {
    await gateway.close();
    restoreEnv("ALLOW_PUBLIC_SERVER_ENROLLMENT", previous.enrollment);
    restoreEnv("TENANT_STATE_DIRECTORY", previous.state);
    restoreEnv("TENANT_KEY_DIRECTORY", previous.keys);
    restoreEnv("OPENAI_KEY_ENCRYPTION_SECRET", previous.encryption);
    await rm(directory, { recursive: true, force: true });
  }
});

async function tenantLogin(base: string, serverId: string, password: string) {
  const response = await fetch(`${base}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ serverId, password }),
  });
  assert.equal(response.status, 200);
  const body = await response.json() as { data: { csrfToken: string; serverId: string } };
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie);
  assert.equal(body.data.serverId, serverId);
  return { cookie, csrfToken: body.data.csrfToken };
}

function expectRejectedBridge(url: string, serverId: string, bridgeToken: string) {
  return new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${bridgeToken}`, "X-Dynamic-AI-Server-Id": serverId } });
    const timeout = setTimeout(() => reject(new Error("bridge rejection timed out")), 3_000);
    socket.once("open", () => reject(new Error("cross-tenant bridge unexpectedly opened")));
    socket.once("unexpected-response", (_request, response) => {
      clearTimeout(timeout);
      assert.equal(response.statusCode, 401);
      response.resume();
      resolve();
    });
    socket.once("error", () => undefined);
  });
}

function nextCommand(socket: WebSocket, method: string) {
  return new Promise<Record<string, unknown>>((resolve) => {
    const listener = (raw: WebSocket.RawData) => {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (message.type !== "command" || message.method !== method) return;
      socket.off("message", listener);
      resolve(message);
    };
    socket.on("message", listener);
  });
}

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
