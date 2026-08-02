import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

interface EncryptedKeyFile {
  version: 1;
  algorithm: "aes-256-gcm";
  iv: string;
  tag: string;
  ciphertext: string;
}

export type OpenAiKeySource = "environment" | "encrypted-store" | "none";

export class OpenAiKeyStore {
  private readonly filePath: string;
  private readonly encryptionKey: Buffer | null;
  private readonly allowEnvironmentKey: boolean;

  constructor(
    filePath = process.env.OPENAI_KEY_STORE_PATH?.trim() || path.resolve("data", "openai-key.json"),
    encryptionSecret = process.env.OPENAI_KEY_ENCRYPTION_SECRET?.trim(),
    allowEnvironmentKey = true,
  ) {
    this.filePath = path.resolve(filePath);
    this.encryptionKey = encryptionSecret ? createHash("sha256").update(encryptionSecret, "utf8").digest() : null;
    this.allowEnvironmentKey = allowEnvironmentKey;
  }

  async read(): Promise<{ key: string | null; source: OpenAiKeySource }> {
    const environmentKey = this.allowEnvironmentKey ? process.env.OPENAI_API_KEY?.trim() : undefined;
    if (environmentKey) return { key: environmentKey, source: "environment" };
    if (!this.encryptionKey) return { key: null, source: "none" };

    try {
      const payload = JSON.parse(await readFile(this.filePath, "utf8")) as EncryptedKeyFile;
      if (payload.version !== 1 || payload.algorithm !== "aes-256-gcm") return { key: null, source: "none" };
      const decipher = createDecipheriv("aes-256-gcm", this.encryptionKey, Buffer.from(payload.iv, "base64url"));
      decipher.setAuthTag(Buffer.from(payload.tag, "base64url"));
      const key = Buffer.concat([
        decipher.update(Buffer.from(payload.ciphertext, "base64url")),
        decipher.final(),
      ]).toString("utf8");
      return isPlausibleOpenAiKey(key) ? { key, source: "encrypted-store" } : { key: null, source: "none" };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return { key: null, source: "none" };
      throw error;
    }
  }

  environmentKey() {
    return this.allowEnvironmentKey ? process.env.OPENAI_API_KEY?.trim() || null : null;
  }

  async write(key: string) {
    if (this.allowEnvironmentKey && process.env.OPENAI_API_KEY?.trim()) {
      throw new OpenAiKeyStoreError("OPENAI_KEY_ENV_MANAGED", "환경변수로 설정된 키는 웹에서 덮어쓸 수 없습니다.", 409);
    }
    if (!this.encryptionKey) {
      throw new OpenAiKeyStoreError("OPENAI_KEY_STORE_NOT_CONFIGURED", "암호화 저장소가 설정되지 않았습니다.", 503);
    }
    if (!isPlausibleOpenAiKey(key)) {
      throw new OpenAiKeyStoreError("INVALID_OPENAI_KEY", "OpenAI API 키 형식을 확인해 주세요.", 400);
    }

    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.encryptionKey, iv);
    const ciphertext = Buffer.concat([cipher.update(key.trim(), "utf8"), cipher.final()]);
    const payload: EncryptedKeyFile = {
      version: 1,
      algorithm: "aes-256-gcm",
      iv: iv.toString("base64url"),
      tag: cipher.getAuthTag().toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
    };

    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(payload)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(temporary, this.filePath);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  async clear() {
    if (this.allowEnvironmentKey && process.env.OPENAI_API_KEY?.trim()) {
      throw new OpenAiKeyStoreError("OPENAI_KEY_ENV_MANAGED", "환경변수로 설정된 키는 웹에서 삭제할 수 없습니다.", 409);
    }
    await unlink(this.filePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

export class OpenAiKeyStoreError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
  }
}

function isPlausibleOpenAiKey(value: string) {
  const key = value.trim();
  return key.startsWith("sk-") && key.length >= 24 && key.length <= 512 && !/\s/.test(key);
}
