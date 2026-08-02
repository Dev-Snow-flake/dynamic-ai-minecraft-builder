import { readFile } from "node:fs/promises";

const [plannedPath, actualPath] = process.argv.slice(2);
if (!plannedPath || !actualPath) {
  console.error("Usage: node --import tsx diff_blueprint.ts <planned.json> <actual.json>");
  process.exit(2);
}

type Placement = { x: number; y: number; z: number; block: string };
const planned = JSON.parse(await readFile(plannedPath, "utf8")) as Placement[];
const actual = JSON.parse(await readFile(actualPath, "utf8")) as Placement[];
const key = (item: Placement) => `${item.x},${item.y},${item.z}`;
const plannedMap = new Map(planned.map((item) => [key(item), item.block]));
const actualMap = new Map(actual.map((item) => [key(item), item.block]));
const missing = [...plannedMap].filter(([position, block]) => actualMap.get(position) !== block);
const extra = [...actualMap].filter(([position]) => !plannedMap.has(position));
console.log(JSON.stringify({ planned: planned.length, actual: actual.length, missing, extra }, null, 2));
