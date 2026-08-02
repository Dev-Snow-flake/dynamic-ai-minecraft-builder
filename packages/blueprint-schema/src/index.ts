import { z } from "zod";

export const Vec3Schema = z.object({
  x: z.number().int(),
  y: z.number().int(),
  z: z.number().int(),
});

export const BlockStateSchema = z
  .string()
  .regex(/^minecraft:[a-z0-9_]+(?:\[[a-z0-9_=,]+\])?$/, "정규화된 Minecraft 블록 상태가 아닙니다.");

export const BlueprintSchema = z
  .object({
    schemaVersion: z.literal(1),
    blueprintId: z.string().min(3),
    buildId: z.string().min(3),
    planVersion: z.number().int().positive(),
    worldId: z.string().min(1),
    origin: Vec3Schema,
    bounds: z.object({
      min: Vec3Schema,
      maxExclusive: Vec3Schema,
    }),
    intent: z.string().min(4).max(500),
    palette: z.record(z.string(), BlockStateSchema),
    phases: z
      .array(
        z.object({
          id: z.string().min(1),
          order: z.number().int(),
          placementRef: z.string().min(1),
        }),
      )
      .min(1),
    estimates: z.object({
      changedBlocks: z.number().int().nonnegative(),
      placedBlocks: z.number().int().nonnegative(),
      removedBlocks: z.number().int().nonnegative(),
    }),
    constraints: z.object({
      preserveTerrain: z.boolean(),
      playerExclusionRadius: z.number().int().min(0).max(128),
      prohibitedBlocks: z.array(BlockStateSchema),
    }),
    sourceSnapshotId: z.string().min(3),
    sourceRegionHash: z.string().startsWith("sha256:"),
  })
  .superRefine((value, context) => {
    const { min, maxExclusive } = value.bounds;
    if (maxExclusive.x <= min.x || maxExclusive.y <= min.y || maxExclusive.z <= min.z) {
      context.addIssue({
        code: "custom",
        path: ["bounds"],
        message: "maxExclusive는 모든 축에서 min보다 커야 합니다.",
      });
    }
    if (value.estimates.changedBlocks !== value.estimates.placedBlocks + value.estimates.removedBlocks) {
      context.addIssue({
        code: "custom",
        path: ["estimates", "changedBlocks"],
        message: "changedBlocks는 placedBlocks와 removedBlocks의 합이어야 합니다.",
      });
    }
    const volume =
      (maxExclusive.x - min.x) * (maxExclusive.y - min.y) * (maxExclusive.z - min.z);
    if (volume > 64 * 64 * 64) {
      context.addIssue({
        code: "custom",
        path: ["bounds"],
        message: "MVP 최대 영역 64×64×64를 초과했습니다.",
      });
    }
  });

export type Blueprint = z.infer<typeof BlueprintSchema>;

export function validateBlueprint(input: unknown) {
  return BlueprintSchema.safeParse(input);
}
