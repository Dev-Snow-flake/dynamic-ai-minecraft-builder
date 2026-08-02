import { useEffect, useRef, useState } from "react";
import {
  Box3,
  Box3Helper,
  BoxGeometry,
  Color,
  DirectionalLight,
  FogExp2,
  GridHelper,
  HemisphereLight,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  NearestFilter,
  NearestMipmapLinearFilter,
  PCFShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  RepeatWrapping,
  Scene,
  SRGBColorSpace,
  TextureLoader,
  Vector3,
  WebGLRenderer,
  type Material,
  type Texture,
} from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { SiteSnapshot } from "@dynamic-ai/protocol";

export type VoxelLayer = "plan" | "existing" | "difference";

const colors = {
  grass: 0x596a4d,
  stone: 0x7b7e78,
  water: 0x496f76,
  spruce: 0x8a5a38,
  stone_brick: 0x9a9b92,
  glass: 0x9ec3c4,
  copper: 0x5c9b82,
} as const;

interface VoxelPreviewProps {
  snapshot: SiteSnapshot;
  layer: VoxelLayer;
}

type VoxelKind = keyof typeof colors;
type BlockFace = "north" | "south" | "east" | "west" | "up" | "down";

interface TextureManifest {
  pack: { directory: string; description: string };
  blocks: Record<VoxelKind, {
    blockId: string;
    tint: "grass" | "water" | null;
    transparent: boolean;
    faces: Record<BlockFace, { url: string; source: string; animated: boolean }>;
  }>;
}

const materialFaceOrder: BlockFace[] = ["east", "west", "up", "down", "south", "north"];

export function VoxelPreview({ snapshot, layer }: VoxelPreviewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [textureManifest, setTextureManifest] = useState<TextureManifest | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/minecraft/manifest.json", { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`Texture manifest returned ${response.status}`);
        return response.json() as Promise<TextureManifest>;
      })
      .then(setTextureManifest)
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        console.warn("Minecraft texture manifest unavailable; using fallback materials.", error);
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const scene = new Scene();
    scene.background = new Color(0x111512);
    scene.fog = new FogExp2(0x111512, 0.018);

    const camera = new PerspectiveCamera(38, 1, 0.1, 250);
    camera.position.set(34, 29, 43);

    const renderer = new WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = PCFShadowMap;
    host.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 4, 0);
    controls.enableDamping = true;
    controls.dampingFactor = 0.07;
    controls.minDistance = 22;
    controls.maxDistance = 80;
    controls.maxPolarAngle = Math.PI * 0.48;

    scene.add(new HemisphereLight(0xdde5d5, 0x283129, 2.5));
    const sun = new DirectionalLight(0xffe7ba, 3.2);
    sun.position.set(22, 34, 18);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    scene.add(sun);

    const grid = new GridHelper(64, 32, 0x3f4a40, 0x242b26);
    grid.position.y = -2;
    scene.add(grid);

    const floor = new Mesh(
      new PlaneGeometry(80, 80),
      new MeshStandardMaterial({ color: 0x171c18, roughness: 1 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -2.03;
    floor.receiveShadow = true;
    scene.add(floor);

    const cube = new BoxGeometry(1.78, 1.78, 1.78);
    const disposableMaterials: Material[] = [];
    const textureCache = new Map<string, Texture>();
    const textureLoader = new TextureLoader();

    const getTexture = (url: string, animated: boolean) => {
      const existing = textureCache.get(url);
      if (existing) return existing;
      const texture = textureLoader.load(url, (loaded) => {
        if (animated) {
          const image = loaded.image as { width?: number; height?: number };
          if (image.width && image.height && image.height > image.width) {
            const frameRatio = image.width / image.height;
            loaded.repeat.set(1, frameRatio);
            loaded.offset.set(0, 1 - frameRatio);
          }
        }
        loaded.needsUpdate = true;
      });
      texture.colorSpace = SRGBColorSpace;
      texture.magFilter = NearestFilter;
      texture.minFilter = NearestMipmapLinearFilter;
      texture.wrapS = RepeatWrapping;
      texture.wrapT = RepeatWrapping;
      textureCache.set(url, texture);
      return texture;
    };

    const createMaterials = (kind: VoxelKind, opacity: number) => {
      const block = textureManifest?.blocks[kind];
      return materialFaceOrder.map((face) => {
        const faceAsset = block?.faces[face];
        const nativeTransparency = block?.transparent || kind === "glass" || kind === "water";
        const materialOpacity = kind === "glass" ? 0.52 * opacity : kind === "water" ? 0.76 * opacity : opacity;
        const tint = kind === "water" ? 0x6d95d8 : kind === "grass" && face === "up" ? 0x7fa85c : 0xffffff;
        const material = new MeshStandardMaterial({
          color: faceAsset ? tint : colors[kind],
          map: faceAsset ? getTexture(faceAsset.url, faceAsset.animated) : null,
          transparent: materialOpacity < 1 || nativeTransparency,
          opacity: materialOpacity,
          alphaTest: kind === "glass" ? 0.04 : 0,
          depthWrite: !nativeTransparency,
          roughness: kind === "copper" ? 0.5 : kind === "glass" ? 0.18 : 0.88,
          metalness: kind === "copper" ? 0.2 : 0,
        });
        disposableMaterials.push(material);
        return material;
      });
    };

    const addVoxels = (
      voxels: Array<{ x: number; y: number; z: number; kind: VoxelKind }>,
      opacity: number,
    ) => {
      const byKind = new Map<VoxelKind, typeof voxels>();
      for (const voxel of voxels) {
        const items = byKind.get(voxel.kind) ?? [];
        items.push(voxel);
        byKind.set(voxel.kind, items);
      }
      for (const [kind, items] of byKind) {
        const materials = createMaterials(kind, opacity);
        const mesh = new InstancedMesh(cube, materials, items.length);
        mesh.castShadow = kind !== "glass" && kind !== "water";
        mesh.receiveShadow = true;
        const matrix = new Matrix4();
        items.forEach((item, index) => {
          matrix.setPosition(item.x, item.y, item.z);
          mesh.setMatrixAt(index, matrix);
        });
        scene.add(mesh);
      }
    };

    if (layer !== "plan") addVoxels(snapshot.terrain, layer === "difference" ? 0.5 : 1);
    if (layer !== "existing") addVoxels(snapshot.blueprint, layer === "difference" ? 0.9 : 1);

    if (layer === "difference") {
      const bounds = new Box3(new Vector3(-11, 0, -7), new Vector3(11, 12, 9));
      const outline = new Box3Helper(bounds, 0xd9a74f);
      scene.add(outline);
    }

    let frame = 0;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const animate = () => {
      controls.update();
      renderer.render(scene, camera);
      frame = window.requestAnimationFrame(animate);
    };

    const resize = () => {
      const width = host.clientWidth;
      const height = host.clientHeight;
      if (!width || !height) return;
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
      if (reducedMotion) renderer.render(scene, camera);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();
    animate();

    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(frame);
      controls.dispose();
      cube.dispose();
      floor.geometry.dispose();
      (floor.material as Material).dispose();
      disposableMaterials.forEach((material) => material.dispose());
      textureCache.forEach((texture) => texture.dispose());
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [layer, snapshot, textureManifest]);

  return (
    <div
      className="voxel-host"
      ref={hostRef}
      aria-label={textureManifest ? `${textureManifest.pack.description} 실제 블록 텍스처를 사용하는 건축 현장 3D 미리보기` : "건축 현장 3D 미리보기"}
    />
  );
}
