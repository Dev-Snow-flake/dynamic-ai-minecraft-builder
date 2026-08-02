import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
const SERVER_ID = /^srv_[a-f0-9]{24}$/;
const INSTALLATION_ID = /^[a-f0-9-]{36}$/i;
const SECRET = /^[A-Za-z0-9_-]{43,128}$/;
const CLAIM_TTL_MS = 30 * 60 * 1_000;
const CLAIM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

interface PersistedTenant {
  serverId: string;
  installationIdHash: string;
  bridgeTokenHash: string;
  claimCodeHash: string | null;
  claimExpiresAt: string | null;
  passwordSalt: string | null;
  passwordHash: string | null;
  displayName: string;
  createdAt: string;
  claimedAt: string | null;
}

interface RegistryFile {
  schemaVersion: 1;
  tenants: PersistedTenant[];
}

export interface TenantSummary {
  serverId: string;
  displayName: string;
  claimed: boolean;
  createdAt: string;
  claimedAt: string | null;
}

export interface EnrollmentInput {
  installationId: string;
  bridgeToken: string;
  displayName?: string;
}

export interface EnrollmentResult {
  serverId: string;
  claimCode: string;
  claimExpiresAt: string;
  displayName: string;
}

export class TenantRegistry {
  private readonly tenants = new Map<string, PersistedTenant>();
  private readonly filePath: string | null;
  private mutationQueue = Promise.resolve();

  constructor(filePath: string | null = process.env.TENANT_REGISTRY_PATH?.trim() || path.resolve("data", "tenant-registry.json")) {
    this.filePath = filePath ? path.resolve(filePath) : null;
    this.load();
  }

  async enroll(input: EnrollmentInput): Promise<EnrollmentResult> {
    return this.mutate(async () => {
      const installationId = String(input.installationId ?? "").trim();
      const bridgeToken = String(input.bridgeToken ?? "").trim();
      const displayName = sanitizeDisplayName(input.displayName);
      if (!INSTALLATION_ID.test(installationId) || !SECRET.test(bridgeToken)) {
        throw new TenantRegistryError("INVALID_ENROLLMENT", "설치 식별자 또는 브리지 자격 증명 형식이 올바르지 않습니다.", 400);
      }

      const installationIdHash = digest(installationId.toLowerCase());
      const bridgeTokenHash = digest(bridgeToken);
      this.pruneExpiredPending();
      const existing = [...this.tenants.values()].find((tenant) => tenant.installationIdHash === installationIdHash);
      const configuredMaximum = Number(process.env.MAX_HOSTED_TENANTS ?? 10_000);
      const maximumTenants = Number.isSafeInteger(configuredMaximum) && configuredMaximum > 0 ? configuredMaximum : 10_000;
      if (!existing && this.tenants.size >= maximumTenants) {
        throw new TenantRegistryError("TENANT_CAPACITY_REACHED", "현재 새 서버 등록 용량이 모두 사용 중입니다.", 503);
      }
      if (existing && !safeEqual(existing.bridgeTokenHash, bridgeTokenHash)) {
        throw new TenantRegistryError("INSTALLATION_CONFLICT", "설치 식별자가 다른 자격 증명에 연결되어 있습니다.", 409);
      }
      if (existing?.claimedAt) {
        throw new TenantRegistryError("SERVER_ALREADY_CLAIMED", "이미 소유권 등록이 완료된 서버입니다.", 409);
      }

      const claimCode = createClaimCode();
      const claimExpiresAt = new Date(Date.now() + CLAIM_TTL_MS).toISOString();
      const tenant: PersistedTenant = existing ?? {
        serverId: createServerId(),
        installationIdHash,
        bridgeTokenHash,
        claimCodeHash: null,
        claimExpiresAt: null,
        passwordSalt: null,
        passwordHash: null,
        displayName,
        createdAt: new Date().toISOString(),
        claimedAt: null,
      };
      tenant.bridgeTokenHash = bridgeTokenHash;
      tenant.claimCodeHash = digest(normalizeClaimCode(claimCode));
      tenant.claimExpiresAt = claimExpiresAt;
      tenant.displayName = displayName || tenant.displayName;
      this.tenants.set(tenant.serverId, tenant);
      await this.persist();
      return { serverId: tenant.serverId, claimCode, claimExpiresAt, displayName: tenant.displayName };
    });
  }

  async claim(serverId: unknown, claimCode: unknown, password: unknown, displayName?: unknown): Promise<TenantSummary> {
    return this.mutate(async () => {
      const tenant = this.requireTenant(serverId);
      if (tenant.claimedAt) throw new TenantRegistryError("SERVER_ALREADY_CLAIMED", "이미 소유권 등록이 완료된 서버입니다.", 409);
      if (!tenant.claimCodeHash || !tenant.claimExpiresAt || Date.parse(tenant.claimExpiresAt) <= Date.now()) {
        throw new TenantRegistryError("CLAIM_CODE_EXPIRED", "소유권 코드가 만료되었습니다. 플러그인을 재시작해 새 코드를 발급받으세요.", 410);
      }
      const normalizedCode = normalizeClaimCode(String(claimCode ?? ""));
      if (!safeEqual(tenant.claimCodeHash, digest(normalizedCode))) {
        throw new TenantRegistryError("INVALID_CLAIM_CODE", "서버 ID 또는 소유권 코드가 올바르지 않습니다.", 401);
      }
      const passwordText = validatePassword(password);
      const salt = randomBytes(16);
      const derived = await derivePassword(passwordText, salt);
      tenant.passwordSalt = salt.toString("base64url");
      tenant.passwordHash = derived.toString("base64url");
      tenant.claimCodeHash = null;
      tenant.claimExpiresAt = null;
      tenant.claimedAt = new Date().toISOString();
      if (typeof displayName === "string") tenant.displayName = sanitizeDisplayName(displayName);
      await this.persist();
      return summarize(tenant);
    });
  }

  async authenticate(serverId: unknown, password: unknown): Promise<TenantSummary | null> {
    if (typeof serverId !== "string" || typeof password !== "string" || password.length > 512) return null;
    const tenant = this.tenants.get(serverId.trim());
    if (!tenant?.claimedAt || !tenant.passwordHash || !tenant.passwordSalt) return null;
    const actual = await derivePassword(password, Buffer.from(tenant.passwordSalt, "base64url"));
    const expected = Buffer.from(tenant.passwordHash, "base64url");
    return actual.length === expected.length && timingSafeEqual(actual, expected) ? summarize(tenant) : null;
  }

  authenticateBridge(serverId: unknown, bridgeToken: unknown): TenantSummary | null {
    if (typeof serverId !== "string" || typeof bridgeToken !== "string" || !SECRET.test(bridgeToken)) return null;
    const tenant = this.tenants.get(serverId.trim());
    if (!tenant || !safeEqual(tenant.bridgeTokenHash, digest(bridgeToken))) return null;
    return summarize(tenant);
  }

  get(serverId: string): TenantSummary | null {
    const tenant = this.tenants.get(serverId);
    return tenant ? summarize(tenant) : null;
  }

  private requireTenant(serverId: unknown) {
    const id = typeof serverId === "string" ? serverId.trim() : "";
    if (!SERVER_ID.test(id)) throw new TenantRegistryError("INVALID_SERVER_ID", "서버 ID 형식이 올바르지 않습니다.", 400);
    const tenant = this.tenants.get(id);
    if (!tenant) throw new TenantRegistryError("SERVER_NOT_FOUND", "등록된 서버를 찾을 수 없습니다.", 404);
    return tenant;
  }

  private pruneExpiredPending() {
    const cutoff = Date.now() - 24 * 60 * 60 * 1_000;
    for (const [serverId, tenant] of this.tenants) {
      if (!tenant.claimedAt && Date.parse(tenant.createdAt) < cutoff && (!tenant.claimExpiresAt || Date.parse(tenant.claimExpiresAt) <= Date.now())) {
        this.tenants.delete(serverId);
      }
    }
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation, operation);
    this.mutationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private load() {
    if (!this.filePath || !existsSync(this.filePath)) return;
    const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as RegistryFile;
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.tenants)) throw new Error("Unsupported tenant registry schema.");
    for (const tenant of parsed.tenants) {
      if (!SERVER_ID.test(tenant.serverId)) throw new Error("Invalid server ID in tenant registry.");
      this.tenants.set(tenant.serverId, tenant);
    }
  }

  private async persist() {
    if (!this.filePath) return;
    const target = this.filePath;
    const temporary = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    try {
      const payload: RegistryFile = { schemaVersion: 1, tenants: [...this.tenants.values()] };
      await writeFile(temporary, `${JSON.stringify(payload)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(temporary, target);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }
}

export class TenantRegistryError extends Error {
  constructor(public readonly code: string, message: string, public readonly statusCode: number) {
    super(message);
  }
}

function digest(value: string) {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

function safeEqual(left: string, right: string) {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

async function derivePassword(password: string, salt: Buffer) {
  return new Promise<Buffer>((resolve, reject) => {
    scryptCallback(password, salt, 64, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

function validatePassword(value: unknown) {
  if (typeof value !== "string" || value.length < 16 || value.length > 512) {
    throw new TenantRegistryError("INVALID_PASSWORD", "관리 비밀번호는 16자 이상 512자 이하여야 합니다.", 400);
  }
  return value;
}

function sanitizeDisplayName(value: unknown) {
  if (typeof value !== "string") return "Minecraft Server";
  const normalized = value.trim().replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 80);
  return normalized || "Minecraft Server";
}

function normalizeClaimCode(value: string) {
  return value.toUpperCase().replace(/[^A-Z2-9]/g, "");
}

function createServerId() {
  return `srv_${randomBytes(12).toString("hex")}`;
}

function createClaimCode() {
  const bytes = randomBytes(20);
  const raw = [...bytes].map((byte) => CLAIM_ALPHABET[byte % CLAIM_ALPHABET.length]).join("");
  return raw.match(/.{1,5}/g)?.join("-") ?? raw;
}

function summarize(tenant: PersistedTenant): TenantSummary {
  return {
    serverId: tenant.serverId,
    displayName: tenant.displayName,
    claimed: Boolean(tenant.claimedAt),
    createdAt: tenant.createdAt,
    claimedAt: tenant.claimedAt,
  };
}
