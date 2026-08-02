import type {
  BuildEvent,
  BuildJob,
  ServerHealth,
  SiteSnapshot,
} from "@dynamic-ai/protocol";

const now = Date.now();
const ago = (seconds: number) => new Date(now - seconds * 1_000).toISOString();

export const initialServer: ServerHealth = {
  serverId: "server_main",
  name: "Naru Creative",
  version: "Paper 1.21.11",
  world: "world",
  connected: false,
  tps: 0,
  mspt: 0,
  memoryUsedMb: 3_284,
  memoryTotalMb: 8_192,
  queueDepth: 0,
  playersOnline: 0,
  updatedAt: new Date().toISOString(),
};

export const initialJob: BuildJob = {
  buildId: "build_01JMF6RIVER",
  serverId: "server_main",
  title: "강변 기록보관소",
  request: "북쪽 강을 향한 열람실과 구리 지붕이 있는 2층 목조 도서관",
  status: "WAITING_APPROVAL",
  statusReason: "미리보기 샘플입니다. AI 설계로 실제 좌표 청사진을 만든 뒤 Paper 안전 검사가 진행됩니다.",
  agentName: "Mason · Builder 07",
  agentSessionId: "session_01JMF6A2",
  progress: 0,
  appliedBlocks: 0,
  totalBlocks: 6_902,
  etaSeconds: null,
  sequence: 1_842,
  startedAt: null,
  updatedAt: ago(18),
  currentPhaseId: null,
  checkpoint: null,
  blueprint: {
    blueprintId: "bp_01JMF6LIBRARY",
    planVersion: 3,
    intent: "강가를 바라보는 2층 목조 도서관",
    bounds: {
      min: { x: 120, y: 64, z: -42 },
      maxExclusive: { x: 152, y: 84, z: -14 },
    },
    dimensions: { x: 32, y: 20, z: 28 },
    sourceSnapshotId: "preview_fixture",
    sourceRegionHash: "preview:not-a-world-snapshot",
    changedBlocks: 8_421,
    placedBlocks: 6_902,
    removedBlocks: 1_519,
    paletteSize: 14,
    materials: [
      { block: "minecraft:spruce_planks", label: "가문비 판자", count: 2_840, color: "#8b5d3b" },
      { block: "minecraft:stone_bricks", label: "석재 벽돌", count: 1_916, color: "#888a82" },
      { block: "minecraft:oxidized_copper", label: "산화 구리", count: 1_164, color: "#4e8f7e" },
      { block: "minecraft:glass_pane", label: "유리판", count: 982, color: "#a9c7c5" },
    ],
    risks: [
      { code: "REGION_PENDING", label: "작업 범위", detail: "샘플 좌표 · 실제 허용 영역 검사 전", severity: "warning", passed: false },
      { code: "PLAYERS_PENDING", label: "플레이어 거리", detail: "Paper 승인 시 실시간 검사", severity: "warning", passed: false },
      { code: "PALETTE_PENDING", label: "블록 허용 목록", detail: "실행 가능한 청사진 생성 후 검사", severity: "warning", passed: false },
      { code: "LOAD_PENDING", label: "예상 서버 부하", detail: "실제 블록 수와 TPS 기준으로 승인 시 계산", severity: "info", passed: false },
    ],
  },
  phases: [
    { id: "foundation", label: "기초", order: 10, totalBlocks: 1_240, appliedBlocks: 0, state: "PENDING" },
    { id: "structure", label: "구조", order: 20, totalBlocks: 2_436, appliedBlocks: 0, state: "PENDING" },
    { id: "exterior", label: "외장", order: 30, totalBlocks: 2_104, appliedBlocks: 0, state: "PENDING" },
    { id: "interior", label: "내부", order: 40, totalBlocks: 1_122, appliedBlocks: 0, state: "PENDING" },
  ],
  approvals: [],
  executionReady: false,
};

export const initialEvents: BuildEvent[] = [
  {
    eventId: "evt_1837",
    sequence: 1_837,
    type: "world.snapshot.created",
    severity: "info",
    timestamp: ago(73),
    actor: "Preview fixture",
    title: "샘플 현장 데이터 로드",
    detail: "UI 미리보기용 지형이며 실제 Paper 스냅샷이 아닙니다.",
    buildId: initialJob.buildId,
  },
  {
    eventId: "evt_1838",
    sequence: 1_838,
    type: "agent.state.changed",
    severity: "info",
    timestamp: ago(61),
    actor: "Preview fixture",
    title: "샘플 설계 로드",
    detail: "실행 불가 · UI 미리보기 전용",
    buildId: initialJob.buildId,
  },
  {
    eventId: "evt_1839",
    sequence: 1_839,
    type: "build.blueprint.published",
    severity: "success",
    timestamp: ago(52),
    actor: "Preview fixture",
    title: "샘플 청사진 v3 표시",
    detail: "예시 8,421블록 · 실제 월드 쓰기 비활성",
    buildId: initialJob.buildId,
  },
  {
    eventId: "evt_1840",
    sequence: 1_840,
    type: "policy.check.completed",
    severity: "warning",
    timestamp: ago(39),
    actor: "Preview fixture",
    title: "샘플 정책 검사 대기",
    detail: "실행 가능한 좌표와 Paper 실시간 상태가 필요합니다.",
    buildId: initialJob.buildId,
  },
  {
    eventId: "evt_1841",
    sequence: 1_841,
    type: "build.region.reserved",
    severity: "info",
    timestamp: ago(27),
    actor: "Preview fixture",
    title: "샘플 부지 정보",
    detail: "실제 부지를 예약하지 않았습니다.",
    buildId: initialJob.buildId,
  },
  {
    eventId: "evt_1842",
    sequence: 1_842,
    type: "build.approval.requested",
    severity: "warning",
    timestamp: ago(18),
    actor: "Preview fixture",
    title: "샘플 검토 화면 준비",
    detail: "AI 설계실에서 실제 좌표 청사진을 생성해야 승인할 수 있습니다.",
    buildId: initialJob.buildId,
  },
];

export function createSiteSnapshot(): SiteSnapshot {
  const terrain: SiteSnapshot["terrain"] = [];
  const blueprint: SiteSnapshot["blueprint"] = [];

  for (let x = -14; x <= 14; x += 2) {
    for (let z = -12; z <= 12; z += 2) {
      const water = z < -8;
      terrain.push({ x, y: water ? -1 : Math.round(Math.sin(x * 0.4) * 0.45), z, kind: water ? "water" : "grass" });
    }
  }

  for (let x = -9; x <= 9; x += 2) {
    for (let z = -5; z <= 7; z += 2) {
      blueprint.push({ x, y: 1, z, kind: "stone_brick" });
    }
  }

  for (let y = 2; y <= 8; y += 2) {
    for (let x = -9; x <= 9; x += 2) {
      const kind = x % 6 === 0 && y >= 4 ? "glass" : "spruce";
      blueprint.push({ x, y, z: -5, kind });
      blueprint.push({ x, y, z: 7, kind });
    }
    for (let z = -3; z <= 5; z += 2) {
      blueprint.push({ x: -9, y, z, kind: "spruce" });
      blueprint.push({ x: 9, y, z, kind: "spruce" });
    }
  }

  for (let x = -11; x <= 11; x += 2) {
    const height = 11 - Math.floor(Math.abs(x) * 0.28);
    for (let z = -7; z <= 9; z += 2) {
      if ((Math.abs(z) + Math.abs(x)) % 4 === 0) {
        blueprint.push({ x, y: height, z, kind: "copper" });
      }
    }
  }

  return {
    buildId: initialJob.buildId,
    seed: 27,
    origin: { x: 120, y: 64, z: -42 },
    terrain,
    blueprint,
  };
}
