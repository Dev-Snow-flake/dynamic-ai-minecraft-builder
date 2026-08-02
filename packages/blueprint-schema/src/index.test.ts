import assert from "node:assert/strict";
import test from "node:test";
import { validateBlueprint } from "./index.js";

const validBlueprint = {
  schemaVersion: 1,
  blueprintId: "bp_test",
  buildId: "build_test",
  planVersion: 1,
  worldId: "world",
  origin: { x: 0, y: 64, z: 0 },
  bounds: { min: { x: 0, y: 64, z: 0 }, maxExclusive: { x: 16, y: 80, z: 16 } },
  intent: "테스트 정자",
  palette: { "1": "minecraft:spruce_planks" },
  phases: [{ id: "structure", order: 10, placementRef: "placements/structure.rle" }],
  estimates: { changedBlocks: 100, placedBlocks: 90, removedBlocks: 10 },
  constraints: { preserveTerrain: true, playerExclusionRadius: 24, prohibitedBlocks: ["minecraft:bedrock"] },
  sourceSnapshotId: "snap_test",
  sourceRegionHash: "sha256:abc",
};

test("accepts a valid blueprint", () => {
  assert.equal(validateBlueprint(validBlueprint).success, true);
});

test("rejects oversized bounds", () => {
  const oversized = {
    ...validBlueprint,
    bounds: { min: { x: 0, y: 0, z: 0 }, maxExclusive: { x: 65, y: 65, z: 65 } },
  };
  assert.equal(validateBlueprint(oversized).success, false);
});
