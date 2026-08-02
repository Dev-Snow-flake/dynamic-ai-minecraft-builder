import { EventEmitter } from "node:events";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type {
  ApprovalRecord,
  ArchitectDesign,
  AuditEvent,
  BuildEvent,
  BuildJob,
  BuildState,
  BlueprintBlockKind,
  ServerHealth,
  SiteSnapshot,
  WsEventPayload,
} from "@dynamic-ai/protocol";
import { createSiteSnapshot, initialEvents, initialJob, initialServer } from "./fixtures.js";

type ControlAction = "start" | "pause" | "resume" | "cancel" | "rollback";

export interface BridgeExecutionPlan {
  buildId: string;
  planVersion: number;
  world: string;
  bounds: BuildJob["blueprint"]["bounds"];
  blocks: Array<{ x: number; y: number; z: number; block: string }>;
}

export interface BridgeBuildEvent {
  eventType: "build.progress" | "build.paused" | "build.completed" | "build.rollback.progress" | "build.rollback.completed" | "build.failed";
  buildId: string;
  appliedBlocks?: number;
  totalBlocks?: number;
  checkpoint?: string;
  conflicts?: number;
  message?: string;
}

export interface BridgeExecutionStatus {
  buildId: string;
  state: "PREPARING" | "RUNNING" | "PAUSED" | "COMPLETED" | "ROLLING_BACK" | "ROLLED_BACK";
  appliedBlocks?: number;
  totalBlocks?: number;
}

export interface StoreIdentity {
  serverId: string;
  name: string;
}

const copy = <T>(value: T): T => structuredClone(value);

export class ControlCenterStore extends EventEmitter {
  private server: ServerHealth = copy(initialServer);
  private job: BuildJob = copy(initialJob);
  private events: BuildEvent[] = copy(initialEvents);
  private audit: AuditEvent[] = [];
  private snapshot: SiteSnapshot = createSiteSnapshot();
  private executionPlan: BridgeExecutionPlan | null = null;
  private timer: NodeJS.Timeout | null = null;
  private persistTimer: NodeJS.Timeout | null = null;
  private persistPromise: Promise<void> | null = null;
  private persistDirty = false;
  private readonly statePath: string | null;
  private readonly expectedServerId: string;

  constructor(
    statePath: string | null = process.env.CONTROL_CENTER_STATE_PATH?.trim() || path.resolve("data", "control-center-state.json"),
    identity?: StoreIdentity,
  ) {
    super();
    this.statePath = statePath ? path.resolve(statePath) : null;
    if (identity) {
      const buildId = `build_${identity.serverId.slice(0, 48)}`;
      this.server = { ...this.server, serverId: identity.serverId, name: identity.name };
      this.job = { ...this.job, serverId: identity.serverId, buildId };
      this.snapshot = { ...this.snapshot, buildId };
      this.events = this.events.map((event) => ({ ...event, buildId }));
    }
    this.expectedServerId = this.server.serverId;
    this.loadPersistedState();
  }

  async close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = null;
    if (this.persistDirty) await this.persist();
    if (this.persistPromise) await this.persistPromise;
  }

  getServer() {
    return copy(this.server);
  }

  setServerName(name: string) {
    this.server.name = name.slice(0, 80);
    this.server.updatedAt = new Date().toISOString();
  }

  getJob() {
    return copy(this.job);
  }

  getJobs() {
    return [this.getJob()];
  }

  getEvents(after = 0) {
    return copy(this.events.filter((event) => event.sequence > after));
  }

  getAuditEvents() {
    return copy(this.audit);
  }

  getSiteSnapshot() {
    return copy(this.snapshot);
  }

  publishAiDesign(design: ArchitectDesign, requestMessage: string, model: string, target: { world: string; origin: { x: number; y: number; z: number } }) {
    if (["BUILDING", "PAUSE_REQUESTED", "PAUSED", "VALIDATING", "ROLLING_BACK"].includes(this.job.status)) {
      throw new StoreError("ACTIVE_BUILD_LOCKED", "진행 중인 작업을 멈추거나 완료한 뒤 새 청사진을 게시해 주세요.", 409);
    }

    const xOffset = -Math.floor(design.dimensions.x / 2);
    const zOffset = -Math.floor(design.dimensions.z / 2);
    const blocks = new Map<string, { x: number; y: number; z: number; kind: BlueprintBlockKind }>();
    for (const run of design.runs) {
      for (let x = run.xStart; x <= run.xEnd; x += 1) {
        const block = { x: x + xOffset, y: run.y + 1, z: run.z + zOffset, kind: run.material };
        blocks.set(`${block.x}:${block.y}:${block.z}`, block);
      }
    }

    const blueprint = [...blocks.values()];
    if (blueprint.length === 0 || blueprint.length > 12_000) {
      throw new StoreError("INVALID_AI_BLUEPRINT", "생성된 청사진의 블록 수가 허용 범위를 벗어났습니다.", 422);
    }

    const materialMeta: Record<BlueprintBlockKind, { block: string; label: string; color: string }> = {
      spruce: { block: "minecraft:spruce_planks", label: "가문비나무 판자", color: "#8b5d3b" },
      stone_brick: { block: "minecraft:stone_bricks", label: "석재 벽돌", color: "#888a82" },
      glass: { block: "minecraft:glass_pane", label: "유리", color: "#a9c7c5" },
      copper: { block: "minecraft:oxidized_copper", label: "산화 구리", color: "#4e8f7e" },
    };
    const counts = new Map<BlueprintBlockKind, number>();
    for (const block of blueprint) counts.set(block.kind, (counts.get(block.kind) ?? 0) + 1);

    const nextVersion = this.job.blueprint.planVersion + 1;
    const totals = distributePhaseTotals(blueprint.length);
    this.snapshot.origin = copy(target.origin);
    this.snapshot.blueprint = blueprint;
    this.snapshot.seed += 1;
    this.job.title = design.title;
    this.job.request = requestMessage;
    this.job.status = "WAITING_APPROVAL";
    this.job.statusReason = `AI가 청사진 v${nextVersion}을 생성했습니다. 월드 반영 전 사람의 승인이 필요합니다.`;
    this.job.progress = 0;
    this.job.appliedBlocks = 0;
    this.job.totalBlocks = blueprint.length;
    this.job.etaSeconds = null;
    this.job.startedAt = null;
    this.job.currentPhaseId = null;
    this.job.checkpoint = null;
    this.job.approvals = [];
    this.job.executionReady = true;
    this.job.blueprint = {
      blueprintId: `bp_ai_${crypto.randomUUID()}`,
      planVersion: nextVersion,
      intent: design.intent,
      bounds: {
        min: {
          x: this.snapshot.origin.x + xOffset,
          y: this.snapshot.origin.y + 1,
          z: this.snapshot.origin.z + zOffset,
        },
        maxExclusive: {
          x: this.snapshot.origin.x + xOffset + design.dimensions.x,
          y: this.snapshot.origin.y + 1 + design.dimensions.y,
          z: this.snapshot.origin.z + zOffset + design.dimensions.z,
        },
      },
      dimensions: copy(design.dimensions),
      sourceSnapshotId: `snap_ai_${Date.now()}`,
      sourceRegionHash: "pending:paper-preflight",
      changedBlocks: blueprint.length,
      placedBlocks: blueprint.length,
      removedBlocks: 0,
      paletteSize: counts.size,
      materials: [...counts.entries()].map(([kind, count]) => ({ ...materialMeta[kind], count })),
      risks: [
        {
          code: "AI_BLUEPRINT_REVIEW",
          label: "AI 생성 청사진",
          detail: `${model} 생성 결과 · 실제 월드 반영 전 수동 승인 필요`,
          severity: "warning",
          passed: false,
        },
        ...design.risks.map((risk, index) => ({
          code: `AI_RISK_${index + 1}`,
          label: risk.label,
          detail: risk.detail,
          severity: risk.severity,
          passed: risk.severity === "info",
        })),
      ],
    };
    this.job.phases = [
      { id: "foundation", label: "기초", order: 10, totalBlocks: totals[0], appliedBlocks: 0, state: "PENDING" },
      { id: "structure", label: "구조", order: 20, totalBlocks: totals[1], appliedBlocks: 0, state: "PENDING" },
      { id: "exterior", label: "외장", order: 30, totalBlocks: totals[2], appliedBlocks: 0, state: "PENDING" },
      { id: "interior", label: "마감", order: 40, totalBlocks: totals[3], appliedBlocks: 0, state: "PENDING" },
    ];
    const materialBlocks: Record<BlueprintBlockKind, string> = {
      spruce: "minecraft:spruce_planks",
      stone_brick: "minecraft:stone_bricks",
      glass: "minecraft:glass",
      copper: "minecraft:oxidized_copper",
    };
    this.executionPlan = {
      buildId: this.job.buildId,
      planVersion: nextVersion,
      world: target.world,
      bounds: copy(this.job.blueprint.bounds),
      blocks: blueprint.map((block) => ({
        x: target.origin.x + block.x,
        y: target.origin.y + block.y,
        z: target.origin.z + block.z,
        block: materialBlocks[block.kind],
      })),
    };
    this.record(
      "build.blueprint.ai_published",
      "warning",
      "Quarry Architect",
      `AI 청사진 v${nextVersion} 게시`,
      `${blueprint.length.toLocaleString()}블록 · ${counts.size}개 재료 · 승인 대기`,
    );
    this.persistSoon();
    return { job: this.getJob(), snapshot: this.getSiteSnapshot() };
  }

  getExecutionPlan(planVersion: number) {
    if (this.job.status !== "WAITING_APPROVAL") throw new StoreError("INVALID_STATE", "현재 작업은 승인 대기 상태가 아닙니다.", 409);
    if (planVersion !== this.job.blueprint.planVersion) throw new StoreError("PLAN_VERSION_MISMATCH", "최신 청사진 버전과 승인 버전이 다릅니다.", 409);
    if (!this.server.connected) throw new StoreError("BRIDGE_DISCONNECTED", "Paper Bridge가 연결되어 있지 않아 시공을 시작할 수 없습니다.", 503);
    if (!this.executionPlan || !this.job.executionReady) throw new StoreError("WORLD_WRITE_NOT_CONNECTED", "실행 가능한 Paper 청사진이 없습니다.", 503);
    return copy(this.executionPlan);
  }

  setBridgeConnected(connected: boolean) {
    if (this.server.connected === connected) return;
    this.server.connected = connected;
    this.server.updatedAt = new Date().toISOString();
    this.record(
      connected ? "server.bridge.connected" : "server.bridge.disconnected",
      connected ? "success" : "critical",
      "Paper Bridge",
      connected ? "Paper Bridge 연결" : "Paper Bridge 연결 끊김",
      connected ? `${this.server.serverId} 명령 채널이 준비되었습니다.` : "새 월드 쓰기를 차단하고 재연결을 기다립니다.",
    );
  }

  updateServerHealth(data: {
    version?: string;
    tps?: number;
    mspt?: number;
    playersOnline?: number;
    memoryUsedMb?: number;
    memoryTotalMb?: number;
    worlds?: string[];
    build?: BridgeExecutionStatus;
  }) {
    if (data.version) this.server.version = data.version;
    if (typeof data.tps === "number") this.server.tps = Number(data.tps.toFixed(2));
    if (typeof data.mspt === "number") this.server.mspt = Number(data.mspt.toFixed(1));
    if (typeof data.playersOnline === "number") this.server.playersOnline = data.playersOnline;
    if (typeof data.memoryUsedMb === "number") this.server.memoryUsedMb = Math.max(0, Math.round(data.memoryUsedMb));
    if (typeof data.memoryTotalMb === "number") this.server.memoryTotalMb = Math.max(1, Math.round(data.memoryTotalMb));
    if (data.worlds?.[0]) this.server.world = data.worlds[0];
    if (data.build) this.reconcileBridgeExecution(data.build);
    this.server.connected = true;
    this.server.updatedAt = new Date().toISOString();
    this.record(
      "server.health.updated",
      this.server.tps >= 18 && this.server.mspt <= 40 ? "info" : "warning",
      "Paper Bridge",
      "서버 상태 갱신",
      `${this.server.tps.toFixed(2)} TPS · ${this.server.mspt.toFixed(1)} MSPT · ${this.server.playersOnline}명 접속`,
    );
  }

  markStartDispatchUnconfirmed(message: string) {
    if (this.job.status !== "BUILDING") return;
    this.transition("PAUSED", "Paper Bridge의 시작 확인을 받지 못했습니다. 연결 상태를 확인한 뒤 재개해 주세요.");
    this.record("build.start.unconfirmed", "warning", "Gateway", "시공 시작 확인 실패", message.slice(0, 400));
  }

  approve(decision: ApprovalRecord["decision"], actor: string, comment: string, planVersion: number) {
    if (planVersion !== this.job.blueprint.planVersion) {
      throw new StoreError("PLAN_VERSION_MISMATCH", "최신 청사진 버전과 승인 버전이 다릅니다.", 409);
    }
    if (this.job.status !== "WAITING_APPROVAL") {
      throw new StoreError("INVALID_STATE", "현재 상태에서는 승인 결정을 변경할 수 없습니다.", 409);
    }
    if (decision === "approved") this.getExecutionPlan(planVersion);

    const approval: ApprovalRecord = {
      id: `approval_${crypto.randomUUID()}`,
      planVersion,
      decision,
      actor,
      comment,
      createdAt: new Date().toISOString(),
    };
    this.job.approvals.push(approval);

    if (decision === "approved") {
      this.transition("BUILDING", `승인된 청사진 v${planVersion} 시공을 시작했습니다.`);
      this.job.startedAt = new Date().toISOString();
      this.job.currentPhaseId = this.job.phases[0]?.id ?? null;
      if (this.job.phases[0]) this.job.phases[0].state = "ACTIVE";
    } else if (decision === "changes_requested") {
      this.transition("DESIGNING", "승인자의 수정 요청을 Agent에 전달했습니다.");
      this.job.executionReady = false;
    } else {
      this.transition("CANCELLED", "청사진이 거절되어 부지 예약을 해제했습니다.");
    }

    this.record(
      "build.approval.resolved",
      decision === "approved" ? "success" : "warning",
      actor,
      decision === "approved" ? `청사진 v${planVersion} 승인` : decision === "changes_requested" ? "수정 요청 전달" : "청사진 거절",
      comment || "의견 없음",
    );
    this.persistSoon();
    return copy(approval);
  }

  control(action: ControlAction, actor: string) {
    switch (action) {
      case "start": {
        if (this.job.status !== "WAITING_APPROVAL" || !this.job.approvals.some((item) => item.decision === "approved")) {
          throw new StoreError("APPROVAL_REQUIRED", "승인된 청사진만 시작할 수 있습니다.", 409);
        }
        this.transition("BUILDING", "운영자가 시공을 시작했습니다.");
        break;
      }
      case "pause": {
        if (this.job.status === "PAUSE_REQUESTED") return this.getJob();
        this.requireState(["BUILDING"]);
        this.transition("PAUSE_REQUESTED", "현재 배치가 끝나는 체크포인트에서 정지합니다.");
        this.record("build.pause.requested", "warning", actor, "안전 정지 요청", "현재 배치 완료 후 일시정지합니다.");
        return this.getJob();
      }
      case "resume": {
        this.requireState(["PAUSED"]);
        this.transition("BUILDING", "정책과 서버 상태를 재검사하고 시공을 재개했습니다.");
        this.record("build.resumed", "success", actor, "시공 재개", "TPS와 플레이어 안전거리를 재검사했습니다.");
        return this.getJob();
      }
      case "cancel":
      case "rollback": {
        this.requireState(["BUILDING", "PAUSED", "COMPLETED", "FAILED"]);
        this.transition("ROLLING_BACK", action === "cancel" ? "취소 요청에 따라 원본 상태를 복구합니다." : "선택한 체크포인트를 역순으로 복구합니다.");
        this.record("build.rollback.started", "critical", actor, action === "cancel" ? "취소 및 롤백 시작" : "전체 롤백 시작", `${this.job.appliedBlocks.toLocaleString()}블록 복구 예정`);
        return this.getJob();
      }
    }
    return this.getJob();
  }

  applyBridgeBuildEvent(event: BridgeBuildEvent) {
    if (event.buildId !== this.job.buildId) throw new StoreError("BUILD_ID_MISMATCH", "Paper Bridge 작업 ID가 현재 작업과 다릅니다.", 409);
    const total = Math.max(1, event.totalBlocks ?? this.job.totalBlocks);
    const applied = Math.max(0, Math.min(total, event.appliedBlocks ?? this.job.appliedBlocks));
    this.job.totalBlocks = total;
    this.job.appliedBlocks = applied;
    this.job.progress = Math.round((applied / total) * 1_000) / 10;
    this.job.checkpoint = event.checkpoint ?? this.job.checkpoint;
    this.job.etaSeconds = null;
    this.updatePhases();

    switch (event.eventType) {
      case "build.progress":
        this.transition("BUILDING", event.message ?? "Paper Bridge가 승인된 청사진을 배치하고 있습니다.");
        this.record("build.progress.updated", "info", "Paper Bridge", "실제 월드 시공", `${applied.toLocaleString()} / ${total.toLocaleString()}블록`);
        break;
      case "build.paused":
        this.transition("PAUSED", event.message ?? "체크포인트에서 안전하게 정지했습니다.");
        this.record("build.paused", "warning", "Paper Bridge", "시공 일시정지", this.job.checkpoint ?? "초기 체크포인트");
        break;
      case "build.completed":
        this.job.appliedBlocks = total;
        this.job.progress = 100;
        this.updatePhases();
        this.transition("COMPLETED", event.message ?? "Paper 월드와 승인된 청사진이 일치합니다.");
        this.record("build.validation.completed", "success", "Paper Bridge", "실제 월드 시공 완료", `${total.toLocaleString()}블록 검증 완료`);
        break;
      case "build.rollback.progress":
        this.transition("ROLLING_BACK", event.message ?? "원본 블록 상태를 역순으로 복구하고 있습니다.");
        this.record("build.rollback.progress", "warning", "Paper Bridge", "실제 월드 롤백", `${applied.toLocaleString()}블록 남음`);
        break;
      case "build.rollback.completed":
        this.job.appliedBlocks = 0;
        this.job.progress = 0;
        this.resetPhasesFromApplied();
        this.transition("CANCELLED", event.message ?? "원본 블록 상태로 복구했습니다.");
        this.record("build.rollback.completed", (event.conflicts ?? 0) > 0 ? "warning" : "success", "Paper Bridge", "실제 월드 롤백 완료", `충돌 ${(event.conflicts ?? 0).toLocaleString()}건`);
        break;
      case "build.failed":
        this.transition("FAILED", event.message ?? "Paper Bridge 시공 중 오류가 발생했습니다.");
        this.record("build.failed", "critical", "Paper Bridge", "실제 월드 시공 실패", event.message ?? "운영자 확인이 필요합니다.");
        break;
    }
    return this.getJob();
  }

  private reconcileBridgeExecution(status: BridgeExecutionStatus) {
    if (status.buildId !== this.job.buildId || this.job.status === "WAITING_APPROVAL") return;
    const total = Math.max(1, status.totalBlocks ?? this.job.totalBlocks);
    const applied = Math.max(0, Math.min(total, status.appliedBlocks ?? this.job.appliedBlocks));
    this.job.totalBlocks = total;
    this.job.appliedBlocks = applied;
    this.job.progress = Math.round((applied / total) * 1_000) / 10;
    this.updatePhases();

    if (status.state === "RUNNING" && this.job.status !== "BUILDING") {
      this.transition("BUILDING", "Paper Bridge 실행 상태와 다시 동기화했습니다.");
      this.record("build.state.reconciled", "success", "Paper Bridge", "시공 상태 복구", "Paper에서 실행 중인 작업을 확인했습니다.");
    } else if (status.state === "PAUSED" && !["PAUSED", "CANCELLED", "COMPLETED"].includes(this.job.status)) {
      this.transition("PAUSED", "Paper Bridge의 안전 정지 상태와 다시 동기화했습니다.");
      this.record("build.state.reconciled", "warning", "Paper Bridge", "정지 상태 복구", `${applied.toLocaleString()}블록 적용 지점에서 정지했습니다.`);
    } else if (status.state === "COMPLETED" && this.job.status !== "COMPLETED") {
      this.applyBridgeBuildEvent({ eventType: "build.completed", buildId: status.buildId, appliedBlocks: total, totalBlocks: total });
    } else if (status.state === "ROLLING_BACK" && this.job.status !== "ROLLING_BACK") {
      this.transition("ROLLING_BACK", "Paper Bridge에서 진행 중인 롤백과 다시 동기화했습니다.");
      this.record("build.state.reconciled", "warning", "Paper Bridge", "롤백 상태 복구", `${applied.toLocaleString()}블록이 아직 적용된 상태입니다.`);
    } else if (status.state === "ROLLED_BACK" && this.job.status !== "CANCELLED") {
      this.applyBridgeBuildEvent({ eventType: "build.rollback.completed", buildId: status.buildId, appliedBlocks: 0, totalBlocks: total });
    }
  }

  private requireState(states: BuildState[]) {
    if (!states.includes(this.job.status)) {
      throw new StoreError("INVALID_STATE", `${this.job.status} 상태에서는 요청을 수행할 수 없습니다.`, 409);
    }
  }

  private transition(status: BuildState, reason: string) {
    this.job.status = status;
    this.job.statusReason = reason;
    this.job.updatedAt = new Date().toISOString();
    this.persistSoon();
  }

  private updatePhases() {
    let remaining = this.job.appliedBlocks;
    for (const phase of this.job.phases) {
      phase.appliedBlocks = Math.min(phase.totalBlocks, Math.max(0, remaining));
      remaining -= phase.totalBlocks;
      phase.state = phase.appliedBlocks === phase.totalBlocks ? "COMPLETED" : phase.appliedBlocks > 0 ? "ACTIVE" : "PENDING";
    }
    this.job.currentPhaseId = this.job.phases.find((phase) => phase.state === "ACTIVE")?.id ?? this.job.phases.at(-1)?.id ?? null;
  }

  private resetPhasesFromApplied() {
    this.updatePhases();
  }

  private record(type: string, severity: BuildEvent["severity"], actor: string, title: string, detail: string) {
    this.job.sequence += 1;
    this.job.updatedAt = new Date().toISOString();
    const event: BuildEvent = {
      eventId: `evt_${this.job.sequence}_${crypto.randomUUID().slice(0, 6)}`,
      sequence: this.job.sequence,
      type,
      severity,
      timestamp: this.job.updatedAt,
      actor,
      title,
      detail,
      buildId: this.job.buildId,
    };
    this.events.push(event);
    if (this.events.length > 250) this.events.shift();

    if (!type.startsWith("build.progress") && !type.startsWith("build.rollback.progress") && type !== "server.health.updated") {
      this.audit.unshift({
        ...event,
        target: this.job.buildId,
        result: severity === "critical" ? "blocked" : type.includes("requested") ? "allowed" : "completed",
        correlationId: `corr_${crypto.randomUUID().slice(0, 10)}`,
      });
    }

    const payload: WsEventPayload = { event: copy(event), job: this.getJob(), server: this.getServer() };
    this.emit("event", payload);
    if (type !== "server.health.updated") this.persistSoon(type.includes("progress") ? 750 : 100);
  }

  private loadPersistedState() {
    if (!this.statePath || !existsSync(this.statePath)) return;
    try {
      const persisted = JSON.parse(readFileSync(this.statePath, "utf8")) as {
        schemaVersion: 1;
        job: BuildJob;
        events: BuildEvent[];
        audit: AuditEvent[];
        snapshot: SiteSnapshot;
        executionPlan: BridgeExecutionPlan | null;
      };
      if (persisted.schemaVersion !== 1 || !persisted.job || !persisted.snapshot) throw new Error("unsupported state schema");
      if (persisted.job.serverId !== this.expectedServerId) throw new Error("state belongs to a different server");
      this.job = persisted.job;
      this.events = persisted.events ?? [];
      this.audit = persisted.audit ?? [];
      this.snapshot = persisted.snapshot;
      this.executionPlan = persisted.executionPlan ?? null;
      this.job.executionReady = Boolean(this.executionPlan);
      this.server.connected = false;
    } catch (error) {
      throw new Error(`Unable to load persisted control-center state: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private persistSoon(delayMs = 250) {
    if (!this.statePath) return;
    this.persistDirty = true;
    if (this.persistTimer || this.persistPromise) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persist();
    }, delayMs);
    this.persistTimer.unref();
  }

  private persist() {
    if (!this.statePath) return Promise.resolve();
    const statePath = this.statePath;
    if (this.persistPromise) return this.persistPromise;
    this.persistDirty = false;
    const snapshot = `${JSON.stringify({
      schemaVersion: 1,
      job: this.job,
      events: this.events,
      audit: this.audit,
      snapshot: this.snapshot,
      executionPlan: this.executionPlan,
    })}\n`;
    const temporary = `${statePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    this.persistPromise = (async () => {
      await mkdir(path.dirname(statePath), { recursive: true, mode: 0o700 });
      try {
        await writeFile(temporary, snapshot, { encoding: "utf8", mode: 0o600, flag: "wx" });
        await rename(temporary, statePath);
      } finally {
        await unlink(temporary).catch(() => undefined);
      }
    })().finally(() => {
      this.persistPromise = null;
      if (this.persistDirty) this.persistSoon(100);
    });
    return this.persistPromise;
  }
}

export class StoreError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

function distributePhaseTotals(total: number): [number, number, number, number] {
  const foundation = Math.floor(total * 0.2);
  const structure = Math.floor(total * 0.4);
  const exterior = Math.floor(total * 0.25);
  return [foundation, structure, exterior, total - foundation - structure - exterior];
}
