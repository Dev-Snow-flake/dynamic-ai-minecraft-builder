import OpenAI from "openai";
import { z } from "zod";
import type {
  ArchitectDesign,
  ArchitectReply,
  ArchitectRequest,
  ArchitectStatus,
} from "@dynamic-ai/protocol";
import { OpenAiKeyStore, type OpenAiKeySource } from "./openai-key-store.js";

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MATERIALS = ["spruce", "stone_brick", "glass", "copper"] as const;

const historySchema = z.array(z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().trim().min(1).max(4_000),
})).max(12).default([]);

const requestSchema = z.object({
  message: z.string().trim().min(1, "설계 요청을 입력해 주세요.").max(4_000),
  history: historySchema.optional(),
  imageDataUrl: z.string().optional(),
  target: z.object({
    world: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/, "월드 이름 형식이 올바르지 않습니다."),
    origin: z.object({
      x: z.number().int().min(-30_000_000).max(30_000_000),
      y: z.number().int().min(-64).max(319),
      z: z.number().int().min(-30_000_000).max(30_000_000),
    }).strict(),
  }).strict(),
}).strict();

const designSchema = z.object({
  title: z.string().trim().min(1).max(80),
  intent: z.string().trim().min(1).max(400),
  dimensions: z.object({
    x: z.number().int().min(5).max(48),
    y: z.number().int().min(3).max(32),
    z: z.number().int().min(5).max(48),
  }).strict(),
  runs: z.array(z.object({
    y: z.number().int().min(0).max(31),
    z: z.number().int().min(0).max(47),
    xStart: z.number().int().min(0).max(47),
    xEnd: z.number().int().min(0).max(47),
    material: z.enum(MATERIALS),
  }).strict()).min(1).max(2_500),
  risks: z.array(z.object({
    label: z.string().trim().min(1).max(80),
    detail: z.string().trim().min(1).max(240),
    severity: z.enum(["info", "warning"]),
  }).strict()).max(8),
}).strict();

const generationSchema = z.object({
  assistantMessage: z.string().trim().min(1).max(1_200),
  design: designSchema.nullable(),
}).strict();

const outputJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["assistantMessage", "design"],
  properties: {
    assistantMessage: { type: "string", minLength: 1, maxLength: 1200 },
    design: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          required: ["title", "intent", "dimensions", "runs", "risks"],
          properties: {
            title: { type: "string", minLength: 1, maxLength: 80 },
            intent: { type: "string", minLength: 1, maxLength: 400 },
            dimensions: {
              type: "object",
              additionalProperties: false,
              required: ["x", "y", "z"],
              properties: {
                x: { type: "integer", minimum: 5, maximum: 48 },
                y: { type: "integer", minimum: 3, maximum: 32 },
                z: { type: "integer", minimum: 5, maximum: 48 },
              },
            },
            runs: {
              type: "array",
              minItems: 1,
              maxItems: 2500,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["y", "z", "xStart", "xEnd", "material"],
                properties: {
                  y: { type: "integer", minimum: 0, maximum: 31 },
                  z: { type: "integer", minimum: 0, maximum: 47 },
                  xStart: { type: "integer", minimum: 0, maximum: 47 },
                  xEnd: { type: "integer", minimum: 0, maximum: 47 },
                  material: { type: "string", enum: MATERIALS },
                },
              },
            },
            risks: {
              type: "array",
              maxItems: 8,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["label", "detail", "severity"],
                properties: {
                  label: { type: "string", minLength: 1, maxLength: 80 },
                  detail: { type: "string", minLength: 1, maxLength: 240 },
                  severity: { type: "string", enum: ["info", "warning"] },
                },
              },
            },
          },
        },
      ],
    },
  },
} as const;

const SYSTEM_PROMPT = `You are Quarry Architect, a Minecraft build planner.
Reply in Korean. Help the user refine ideas conversationally, but create a design whenever the request is sufficiently concrete.
If an image is attached, use it only as a visual reference and translate its massing, silhouette, colors, and recognizable details into a practical Minecraft build.
Design coordinates are zero-based and must stay inside dimensions. Every run fills xStart through xEnd inclusive at one y/z row; xStart must be <= xEnd.
Use only spruce, stone_brick, glass, and copper. Prefer hollow buildings and efficient run-length rows. Never exceed 12,000 expanded blocks.
Never claim the design has been placed in the Minecraft world. It is only a blueprint and must be approved by a human before any world write.`;

export interface ArchitectService {
  status(): ArchitectStatus;
  generate(input: unknown): Promise<Pick<ArchitectReply, "assistantMessage" | "design" | "model">>;
  configureApiKey?(key: string): Promise<ArchitectStatus>;
  clearApiKey?(): Promise<ArchitectStatus>;
}

export class ArchitectError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
  }
}

export class OpenAiArchitectService implements ArchitectService {
  private readonly model = process.env.OPENAI_MODEL?.trim() || "gpt-5.6-sol";
  private readonly keyStore: OpenAiKeyStore;
  private client: OpenAI | null = null;
  private source: OpenAiKeySource = "none";
  private readonly ready: Promise<void>;

  constructor(keyStore = new OpenAiKeyStore()) {
    this.keyStore = keyStore;
    const environmentKey = process.env.OPENAI_API_KEY?.trim();
    if (environmentKey) {
      this.setClient(environmentKey, "environment");
      this.ready = Promise.resolve();
    } else {
      this.ready = this.loadStoredKey();
    }
  }

  status(): ArchitectStatus {
    return { configured: this.client !== null, model: this.model, source: this.source };
  }

  async configureApiKey(key: string) {
    await this.ready;
    await this.keyStore.write(key);
    this.setClient(key.trim(), "encrypted-store");
    return this.status();
  }

  async clearApiKey() {
    await this.ready;
    await this.keyStore.clear();
    this.client = null;
    this.source = "none";
    return this.status();
  }

  async generate(rawInput: unknown) {
    await this.ready;
    const parsed = requestSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new ArchitectError("INVALID_ARCHITECT_REQUEST", parsed.error.issues[0]?.message ?? "요청 형식이 올바르지 않습니다.", 400);
    }
    if (!this.client) {
      throw new ArchitectError("OPENAI_NOT_CONFIGURED", "서버에 OPENAI_API_KEY를 먼저 설정해 주세요.", 503);
    }

    const { message, history = [], imageDataUrl } = parsed.data;
    if (imageDataUrl) validateImageDataUrl(imageDataUrl);

    const input: OpenAI.Responses.ResponseInput = [
      { role: "developer", content: SYSTEM_PROMPT },
      ...history.map((item) => ({ role: item.role, content: item.content })),
      {
        role: "user",
        content: [
          { type: "input_text", text: message },
          ...(imageDataUrl ? [{ type: "input_image" as const, image_url: imageDataUrl, detail: "high" as const }] : []),
        ],
      },
    ];

    try {
      const response = await this.client.responses.create({
        model: this.model,
        input,
        reasoning: { effort: "medium" },
        text: {
          verbosity: "low",
          format: {
            type: "json_schema",
            name: "minecraft_architect_response",
            strict: true,
            schema: outputJsonSchema,
          },
        },
        max_output_tokens: 12_000,
        store: false,
      });
      if (!response.output_text) {
        throw new ArchitectError("EMPTY_MODEL_RESPONSE", "AI가 빈 응답을 반환했습니다. 요청을 조금 더 구체적으로 작성해 주세요.", 502);
      }
      const generated = generationSchema.parse(JSON.parse(response.output_text));
      if (generated.design) validateDesignCoordinates(generated.design);
      return { ...generated, model: this.model };
    } catch (error) {
      if (error instanceof ArchitectError) throw error;
      if (error instanceof z.ZodError || error instanceof SyntaxError) {
        throw new ArchitectError("INVALID_MODEL_RESPONSE", "AI 설계 결과를 안전한 청사진으로 변환하지 못했습니다. 다시 시도해 주세요.", 502);
      }
      const status = error instanceof OpenAI.APIError ? error.status : undefined;
      if (status === 401) throw new ArchitectError("OPENAI_AUTH_FAILED", "OpenAI API 키를 확인해 주세요.", 502);
      if (status === 429) throw new ArchitectError("OPENAI_RATE_LIMITED", "OpenAI 사용량 한도에 도달했습니다. 잠시 뒤 다시 시도해 주세요.", 429);
      throw new ArchitectError("OPENAI_REQUEST_FAILED", "OpenAI 설계 요청에 실패했습니다. 잠시 뒤 다시 시도해 주세요.", 502);
    }
  }

  private async loadStoredKey() {
    const stored = await this.keyStore.read();
    if (stored.key) this.setClient(stored.key, stored.source);
  }

  private setClient(key: string, source: OpenAiKeySource) {
    this.client = new OpenAI({ apiKey: key, timeout: 90_000, maxRetries: 2 });
    this.source = source;
  }
}

function validateImageDataUrl(value: string) {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(value);
  if (!match) throw new ArchitectError("INVALID_IMAGE", "PNG, JPG 또는 WEBP 이미지만 사용할 수 있습니다.", 400);
  const estimatedBytes = Math.floor((match[2]?.length ?? 0) * 0.75);
  if (estimatedBytes > MAX_IMAGE_BYTES) throw new ArchitectError("IMAGE_TOO_LARGE", "이미지는 8MB 이하여야 합니다.", 413);
}

function validateDesignCoordinates(design: ArchitectDesign) {
  let blockCount = 0;
  for (const run of design.runs) {
    if (run.xStart > run.xEnd || run.xEnd >= design.dimensions.x || run.y >= design.dimensions.y || run.z >= design.dimensions.z) {
      throw new ArchitectError("DESIGN_OUT_OF_BOUNDS", "AI 설계에 작업 영역을 벗어난 블록이 포함되어 있습니다.", 502);
    }
    blockCount += run.xEnd - run.xStart + 1;
  }
  if (blockCount > 12_000) throw new ArchitectError("DESIGN_TOO_LARGE", "AI 설계가 12,000블록 제한을 초과했습니다.", 502);
}
