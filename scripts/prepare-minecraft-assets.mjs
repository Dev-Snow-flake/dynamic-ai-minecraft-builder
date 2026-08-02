import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const textureRoot = path.join(projectRoot, "texture");
const webPublic = path.join(projectRoot, "apps", "web-control-center", "public");
const outputRoot = path.join(webPublic, "minecraft");
const outputBlocks = path.join(outputRoot, "blocks");

if (process.env.SKIP_MINECRAFT_ASSET_PREP === "1") {
  try {
    await stat(path.join(outputRoot, "manifest.json"));
    console.log("Keeping the packaged Minecraft assets (SKIP_MINECRAFT_ASSET_PREP=1).");
    process.exit(0);
  } catch {
    throw new Error("SKIP_MINECRAFT_ASSET_PREP=1 requires a packaged public/minecraft/manifest.json file.");
  }
}

const relativeOutput = path.relative(webPublic, outputRoot);
if (!relativeOutput || relativeOutput.startsWith("..") || path.isAbsolute(relativeOutput)) {
  throw new Error(`Refusing to replace asset output outside web public directory: ${outputRoot}`);
}

const resourcePack = await findResourcePack(textureRoot);

const blockSpecs = {
  grass: { blockId: "grass_block", tint: "grass" },
  stone: { blockId: "stone" },
  water: { blockId: "water", directTexture: "block/water_still", tint: "water", transparent: true },
  spruce: { blockId: "spruce_planks" },
  stone_brick: { blockId: "stone_bricks" },
  glass: { blockId: "glass", transparent: true },
  copper: { blockId: "oxidized_copper" },
};

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputBlocks, { recursive: true });

if (!resourcePack) {
  const fallbackManifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    pack: {
      directory: "none",
      description: "No user-provided Minecraft resource pack",
      packFormat: null,
      source: null,
    },
    blocks: Object.fromEntries(Object.entries(blockSpecs).map(([kind, spec]) => [kind, {
      blockId: `minecraft:${spec.blockId}`,
      model: null,
      tint: spec.tint ?? null,
      transparent: spec.transparent ?? false,
      faces: {},
    }])),
  };
  await writeFile(path.join(outputRoot, "manifest.json"), `${JSON.stringify(fallbackManifest, null, 2)}\n`, "utf8");
  console.warn("No extracted Minecraft resource pack was found. Built the color-only fallback; place a legally obtained pack under texture/ for real block textures.");
  process.exit(0);
}

const minecraftRoot = path.join(resourcePack, "assets", "minecraft");

const packMeta = await readJson(path.join(resourcePack, "pack.mcmeta"));
const sourceInfo = await readOptionalJson(path.join(resourcePack, "SOURCE_INFO.json"));
const manifest = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  pack: {
    directory: path.basename(resourcePack),
    description: packMeta?.pack?.description ?? "Minecraft vanilla resource pack",
    packFormat: packMeta?.pack?.pack_format ?? null,
    source: sourceInfo ?? null,
  },
  blocks: {},
};

for (const [kind, spec] of Object.entries(blockSpecs)) {
  const resolved = spec.directTexture
    ? {
        model: null,
        faces: Object.fromEntries(["north", "south", "east", "west", "up", "down"].map((face) => [face, spec.directTexture])),
      }
    : await resolveBlockModel(minecraftRoot, spec.blockId);

  const faceEntries = {};
  for (const [face, textureId] of Object.entries(resolved.faces)) {
    const source = path.join(minecraftRoot, "textures", `${stripNamespace(textureId)}.png`);
    await stat(source);
    const targetName = `${kind}-${face}.png`;
    await cp(source, path.join(outputBlocks, targetName));
    const mcmetaSource = `${source}.mcmeta`;
    const textureMetadata = await readOptionalJson(mcmetaSource);
    const animated = Boolean(textureMetadata?.animation);
    if (textureMetadata) await cp(mcmetaSource, path.join(outputBlocks, `${targetName}.mcmeta`));
    faceEntries[face] = {
      url: `/minecraft/blocks/${targetName}`,
      source: stripNamespace(textureId),
      animated,
    };
  }

  manifest.blocks[kind] = {
    blockId: `minecraft:${spec.blockId}`,
    model: resolved.model,
    tint: spec.tint ?? null,
    transparent: spec.transparent ?? false,
    faces: faceEntries,
  };
}

await writeFile(path.join(outputRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
await cp(path.join(resourcePack, "pack.png"), path.join(outputRoot, "pack.png"));
console.log(`Prepared ${Object.keys(manifest.blocks).length} textured block materials from ${path.basename(resourcePack)}.`);

async function findResourcePack(root) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(root, entry.name);
    if (await exists(path.join(candidate, "pack.mcmeta")) && await exists(path.join(candidate, "assets", "minecraft"))) {
      return candidate;
    }
  }
  return null;
}

async function resolveBlockModel(root, blockId) {
  const blockState = await readJson(path.join(root, "blockstates", `${blockId}.json`));
  const variant = firstVariant(blockState);
  if (!variant?.model) throw new Error(`No model reference found for minecraft:${blockId}`);
  const modelId = stripNamespace(variant.model);
  const model = await resolveModel(root, modelId, new Set());
  const faces = {};
  const elements = model.elements ?? [];
  for (const direction of ["north", "south", "east", "west", "up", "down"]) {
    const face = elements.flatMap((element) => element.faces?.[direction] ? [element.faces[direction]] : [])[0];
    const reference = face?.texture ?? model.textures?.all ?? model.textures?.particle ?? Object.values(model.textures ?? {})[0];
    faces[direction] = resolveTexture(reference, model.textures ?? {});
  }
  return { model: `minecraft:${modelId}`, faces };
}

async function resolveModel(root, modelId, seen) {
  const normalized = stripNamespace(modelId);
  if (seen.has(normalized)) throw new Error(`Circular block model parent: ${normalized}`);
  seen.add(normalized);
  const model = await readJson(path.join(root, "models", `${normalized}.json`));
  let parent = {};
  if (model.parent) parent = await resolveModel(root, model.parent, seen);
  return {
    ...parent,
    ...model,
    textures: { ...(parent.textures ?? {}), ...(model.textures ?? {}) },
    elements: model.elements ?? parent.elements,
  };
}

function firstVariant(blockState) {
  if (blockState.variants) {
    const value = Object.values(blockState.variants)[0];
    return Array.isArray(value) ? value[0] : value;
  }
  const apply = blockState.multipart?.[0]?.apply;
  return Array.isArray(apply) ? apply[0] : apply;
}

function resolveTexture(reference, textures) {
  let value = typeof reference === "object" && reference ? reference.sprite : reference;
  const visited = new Set();
  while (typeof value === "string" && value.startsWith("#")) {
    const key = value.slice(1);
    if (visited.has(key)) throw new Error(`Circular texture reference: ${key}`);
    visited.add(key);
    value = textures[key];
    if (typeof value === "object" && value) value = value.sprite;
  }
  if (typeof value !== "string") throw new Error(`Unable to resolve block texture: ${String(reference)}`);
  return value;
}

function stripNamespace(value) {
  return value.replace(/^minecraft:/, "");
}

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function readJson(target) {
  return JSON.parse(await readFile(target, "utf8"));
}

async function readOptionalJson(target) {
  return await exists(target) ? readJson(target) : null;
}
