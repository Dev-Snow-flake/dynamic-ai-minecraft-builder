import { readFile } from "node:fs/promises";
import { validateBlueprint } from "@dynamic-ai/blueprint-schema";

const target = process.argv[2];
if (!target) {
  console.error("Usage: node --import tsx validate_blueprint.ts <blueprint.json>");
  process.exit(2);
}

const input = JSON.parse(await readFile(target, "utf8"));
const result = validateBlueprint(input);
if (!result.success) {
  console.error(JSON.stringify(result.error.issues, null, 2));
  process.exit(1);
}
console.log(`Blueprint ${result.data.blueprintId} v${result.data.planVersion} is valid.`);
