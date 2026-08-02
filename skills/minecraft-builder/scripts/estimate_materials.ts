import { readFile } from "node:fs/promises";

const target = process.argv[2];
if (!target) {
  console.error("Usage: node --import tsx estimate_materials.ts <placements.json>");
  process.exit(2);
}

const placements = JSON.parse(await readFile(target, "utf8")) as Array<{ block: string }>;
const counts = new Map<string, number>();
for (const placement of placements) counts.set(placement.block, (counts.get(placement.block) ?? 0) + 1);
console.log(JSON.stringify(Object.fromEntries([...counts].sort((a, b) => b[1] - a[1])), null, 2));
