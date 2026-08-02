export const BUILD_STATES = [
  "IDLE",
  "SURVEYING",
  "DESIGNING",
  "WAITING_APPROVAL",
  "BUILDING",
  "PAUSE_REQUESTED",
  "PAUSED",
  "VALIDATING",
  "COMPLETED",
  "ROLLING_BACK",
  "CANCELLED",
  "FAILED",
] as const;

export type BuildState = (typeof BUILD_STATES)[number];
export type Severity = "info" | "success" | "warning" | "critical";
export type PhaseState = "PENDING" | "ACTIVE" | "COMPLETED";

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Bounds {
  min: Vec3;
  maxExclusive: Vec3;
}

export interface ServerHealth {
  serverId: string;
  name: string;
  version: string;
  world: string;
  connected: boolean;
  tps: number;
  mspt: number;
  memoryUsedMb: number;
  memoryTotalMb: number;
  queueDepth: number;
  playersOnline: number;
  updatedAt: string;
}

export interface BuildPhase {
  id: string;
  label: string;
  order: number;
  totalBlocks: number;
  appliedBlocks: number;
  state: PhaseState;
}

export interface MaterialEstimate {
  block: string;
  label: string;
  count: number;
  color: string;
}

export interface RiskItem {
  code: string;
  label: string;
  detail: string;
  severity: Severity;
  passed: boolean;
}

export interface BlueprintSummary {
  blueprintId: string;
  planVersion: number;
  intent: string;
  bounds: Bounds;
  dimensions: Vec3;
  sourceSnapshotId: string;
  sourceRegionHash: string;
  changedBlocks: number;
  placedBlocks: number;
  removedBlocks: number;
  paletteSize: number;
  materials: MaterialEstimate[];
  risks: RiskItem[];
}

export interface ApprovalRecord {
  id: string;
  planVersion: number;
  decision: "approved" | "rejected" | "changes_requested";
  actor: string;
  comment: string;
  createdAt: string;
}

export interface BuildJob {
  buildId: string;
  serverId: string;
  title: string;
  request: string;
  status: BuildState;
  statusReason: string;
  agentName: string;
  agentSessionId: string;
  progress: number;
  appliedBlocks: number;
  totalBlocks: number;
  etaSeconds: number | null;
  sequence: number;
  startedAt: string | null;
  updatedAt: string;
  currentPhaseId: string | null;
  checkpoint: string | null;
  blueprint: BlueprintSummary;
  phases: BuildPhase[];
  approvals: ApprovalRecord[];
  executionReady: boolean;
}

export interface BuildEvent {
  eventId: string;
  sequence: number;
  type: string;
  severity: Severity;
  timestamp: string;
  actor: string;
  title: string;
  detail: string;
  buildId: string;
}

export interface AuditEvent extends BuildEvent {
  target: string;
  result: "allowed" | "blocked" | "completed";
  correlationId: string;
}

export interface SiteSnapshot {
  buildId: string;
  seed: number;
  origin: Vec3;
  terrain: Array<Vec3 & { kind: "grass" | "stone" | "water" }>;
  blueprint: Array<Vec3 & { kind: "spruce" | "stone_brick" | "glass" | "copper" }>;
}

export type BlueprintBlockKind = SiteSnapshot["blueprint"][number]["kind"];

export interface ArchitectMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ArchitectDesignRun {
  y: number;
  z: number;
  xStart: number;
  xEnd: number;
  material: BlueprintBlockKind;
}

export interface ArchitectDesign {
  title: string;
  intent: string;
  dimensions: Vec3;
  runs: ArchitectDesignRun[];
  risks: Array<{
    label: string;
    detail: string;
    severity: "info" | "warning";
  }>;
}

export interface ArchitectRequest {
  message: string;
  history?: ArchitectMessage[];
  imageDataUrl?: string;
  target: {
    world: string;
    origin: Vec3;
  };
}

export interface ArchitectStatus {
  configured: boolean;
  model: string;
  source?: "environment" | "encrypted-store" | "none";
}

export interface ArchitectReply {
  assistantMessage: string;
  design: ArchitectDesign | null;
  model: string;
  job: BuildJob | null;
  snapshot: SiteSnapshot | null;
}

export interface EventEnvelope<T = unknown> {
  protocolVersion: 1;
  type: "event" | "response" | "command";
  messageId: string;
  correlationId?: string;
  serverId: string;
  buildId?: string;
  sequence: number;
  timestamp: string;
  payload: T;
}

export interface ApiResponse<T> {
  ok: boolean;
  code: string;
  message: string;
  data: T;
  retryable: boolean;
}

export interface WsEventPayload {
  event: BuildEvent;
  job: BuildJob;
  server: ServerHealth;
}
