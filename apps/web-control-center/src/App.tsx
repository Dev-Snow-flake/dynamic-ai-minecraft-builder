import { lazy, Suspense, useEffect, useMemo, useState, type ComponentType } from "react";
import {
  Activity,
  Bot,
  Box,
  Check,
  ChevronRight,
  CirclePause,
  Clock3,
  Command,
  Database,
  FileClock,
  Hammer,
  ImagePlus,
  KeyRound,
  Layers3,
  LogOut,
  Map,
  MapPin,
  MessageSquareText,
  Moon,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  ScrollText,
  Send,
  Server,
  Settings2,
  ShieldCheck,
  Sparkles,
  Sun,
  Trash2,
  TriangleAlert,
  Wifi,
  X,
  XCircle,
} from "lucide-react";
import type {
  ArchitectMessage,
  ArchitectReply,
  ArchitectRequest,
  ArchitectStatus,
  BuildEvent,
  BuildJob,
  BuildState,
  ServerHealth,
  Severity,
} from "@dynamic-ai/protocol";
import { useControlCenter } from "./hooks/useControlCenter";
import type { VoxelLayer } from "./components/VoxelPreview";

const VoxelPreview = lazy(() => import("./components/VoxelPreview").then((module) => ({ default: module.VoxelPreview })));

type NavKey = "overview" | "world" | "jobs" | "agents" | "audit" | "settings";
type ModalKind = "approve" | "changes" | "reject" | "rollback" | "cancel" | null;
type UserRole = "Viewer" | "Reviewer" | "Operator" | "Admin";
const roleRank: Record<UserRole, number> = { Viewer: 0, Reviewer: 1, Operator: 2, Admin: 3 };
const roleAtLeast = (role: UserRole | undefined, required: UserRole) => role !== undefined && roleRank[role] >= roleRank[required];

const navItems: Array<{ id: NavKey; label: string; icon: ComponentType<{ size?: number; strokeWidth?: number }> }> = [
  { id: "overview", label: "개요", icon: Activity },
  { id: "world", label: "월드 맵", icon: Map },
  { id: "jobs", label: "건축 작업", icon: Hammer },
  { id: "agents", label: "AI 설계", icon: Bot },
  { id: "audit", label: "감사 로그", icon: ScrollText },
  { id: "settings", label: "설정", icon: Settings2 },
];

const statusCopy: Record<BuildState, { label: string; tone: Severity }> = {
  IDLE: { label: "대기", tone: "info" },
  SURVEYING: { label: "현장 조사", tone: "info" },
  DESIGNING: { label: "설계 중", tone: "info" },
  WAITING_APPROVAL: { label: "승인 필요", tone: "warning" },
  BUILDING: { label: "시공 중", tone: "success" },
  PAUSE_REQUESTED: { label: "정지 요청", tone: "warning" },
  PAUSED: { label: "일시정지", tone: "warning" },
  VALIDATING: { label: "검증 중", tone: "info" },
  COMPLETED: { label: "완료", tone: "success" },
  ROLLING_BACK: { label: "복구 중", tone: "critical" },
  CANCELLED: { label: "취소됨", tone: "critical" },
  FAILED: { label: "실패", tone: "critical" },
};

const agentSteps = [
  { state: "SURVEYING", label: "현장 조사" },
  { state: "DESIGNING", label: "청사진 설계" },
  { state: "WAITING_APPROVAL", label: "사람 승인" },
  { state: "BUILDING", label: "단계별 시공" },
  { state: "VALIDATING", label: "결과 검증" },
] as const;

function formatTime(timestamp: string) {
  return new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(timestamp));
}

function formatDuration(seconds: number | null) {
  if (seconds === null) return "승인 후 계산";
  if (seconds < 60) return `${seconds}초`;
  return `${Math.floor(seconds / 60)}분 ${seconds % 60}초`;
}

function StatusTag({ status, preview = false }: { status: BuildState; preview?: boolean }) {
  const item = preview ? { label: "미리보기", tone: "info" as Severity } : statusCopy[status];
  return (
    <span className={`status-tag tone-${item.tone}`}>
      <span className="status-tag__dot" aria-hidden="true" />
      {item.label}
    </span>
  );
}

function PanelTitle({ eyebrow, title, action }: { eyebrow: string; title: string; action?: React.ReactNode }) {
  return (
    <div className="panel-title">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h2>{title}</h2>
      </div>
      {action}
    </div>
  );
}

function Navigation({ active, onChange, actor, role, onLogout }: { active: NavKey; onChange: (id: NavKey) => void; actor: string; role: string; onLogout: () => void }) {
  return (
    <nav className="nav-rail" aria-label="주요 메뉴">
      <button className="brand-mark" type="button" onClick={() => onChange("overview")} aria-label="Quarry 개요">
        <Box size={24} strokeWidth={1.7} />
        <span>Q</span>
      </button>
      <div className="nav-rail__items">
        {navItems.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              className={`nav-item ${active === item.id ? "is-active" : ""}`}
              type="button"
              onClick={() => onChange(item.id)}
              aria-current={active === item.id ? "page" : undefined}
              title={item.label}
            >
              <Icon size={20} strokeWidth={1.75} />
              <span>{item.label}</span>
            </button>
          );
        })}
      </div>
      <div className="nav-rail__footer">
        <span className="avatar" aria-hidden="true">SY</span>
        <span className="nav-user">{actor}<br /><small>{role}</small></span>
        <button className="nav-logout" type="button" onClick={onLogout} title="로그아웃" aria-label="로그아웃"><LogOut size={15} /></button>
      </div>
    </nav>
  );
}

function TopBar({
  active,
  server,
  connection,
  theme,
  onTheme,
  onLogout,
}: {
  active: NavKey;
  server: ServerHealth;
  connection: string;
  theme: "light" | "dark";
  onTheme: () => void;
  onLogout: () => void;
}) {
  return (
    <header className="topbar">
      <div className="topbar__context">
        <span className="topbar__product">Quarry /</span>
        <span>{navItems.find((item) => item.id === active)?.label}</span>
      </div>
      <div className="topbar__actions">
        <div className={`connection-state ${connection}`} title={`이벤트 스트림: ${connection}`}>
          <Wifi size={14} />
          <span>{connection === "live" ? "실시간" : connection === "offline" ? "오프라인" : "재연결"}</span>
        </div>
        <div className={`server-compact ${server.connected ? "is-online" : "is-offline"}`}>
          <span className="server-compact__dot" />
          <span>{server.name}</span>
          <small>{server.connected ? `${server.tps.toFixed(2)} TPS` : "Bridge offline"}</small>
        </div>
        <button className="icon-button" type="button" onClick={onTheme} title={`${theme === "dark" ? "라이트" : "다크"} 테마로 전환`}>
          {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
        </button>
        <button className="icon-button topbar-logout" type="button" onClick={onLogout} title="로그아웃" aria-label="로그아웃"><LogOut size={17} /></button>
      </div>
    </header>
  );
}

function BuildDetail({
  job,
  server,
  events,
  snapshot,
  busyAction,
  onModal,
  onControl,
  canReview,
  canOperate,
}: {
  job: BuildJob;
  server: ServerHealth;
  events: BuildEvent[];
  snapshot: NonNullable<ReturnType<typeof useControlCenter>["snapshot"]>;
  busyAction: string | null;
  onModal: (kind: ModalKind) => void;
  onControl: (action: "pause" | "resume") => Promise<void>;
  canReview: boolean;
  canOperate: boolean;
}) {
  const [layer, setLayer] = useState<VoxelLayer>("difference");
  const [eventFilter, setEventFilter] = useState<"all" | "alerts">("all");
  const visibleEvents = eventFilter === "all" ? events : events.filter((event) => event.severity === "warning" || event.severity === "critical");
  const currentStep = job.status === "PAUSED" || job.status === "PAUSE_REQUESTED" || job.status === "ROLLING_BACK" ? 3 : Math.max(0, agentSteps.findIndex((step) => step.state === job.status));
  const safetyPassed = server.connected && job.executionReady && job.blueprint.risks.every((risk) => risk.passed);

  return (
    <main className="page build-page">
      <section className="page-heading">
        <div>
          <div className="breadcrumb"><span>Build Jobs</span><ChevronRight size={13} /><span>{job.buildId.slice(-7)}</span></div>
          <div className="heading-line">
            <h1>{job.title}</h1>
            <StatusTag status={job.status} preview={!job.executionReady} />
          </div>
          <p>{job.request}</p>
        </div>
        <div className="heading-metrics" aria-label="작업 핵심 지표">
          <div><span>계획 버전</span><strong>v{job.blueprint.planVersion}</strong></div>
          <div><span>변경 블록</span><strong>{job.blueprint.changedBlocks.toLocaleString()}</strong></div>
          <div><span>예상 완료</span><strong>{formatDuration(job.etaSeconds)}</strong></div>
        </div>
      </section>

      <section className={`safety-banner ${safetyPassed ? "" : "is-pending"}`} aria-label="안전 상태">
        {safetyPassed ? <ShieldCheck size={18} /> : <TriangleAlert size={18} />}
        <strong>{safetyPassed ? "사전 안전 검사 완료" : "승인 시 Paper 안전 검사"}</strong>
        <span>{safetyPassed ? "허용 영역 · 금지 블록 · 플레이어 반경 · 서버 부하 통과" : "허용 영역 · 청크 · 플레이어 거리 · TPS · 원본 diff를 플러그인이 다시 확인합니다."}</span>
        <span className="safety-banner__hash">{job.executionReady ? `SNAP ${job.blueprint.sourceRegionHash.replace("sha256:", "")}` : "PREVIEW ONLY"}</span>
      </section>

      <div className="workspace-grid">
        <aside className="left-stack">
          <section className="panel agent-panel">
            <PanelTitle eyebrow="Agent execution" title="판단과 단계" action={<Bot size={18} />} />
            <div className="agent-identity">
              <span className="agent-glyph"><Sparkles size={17} /></span>
              <div><strong>{job.agentName}</strong><small>{job.agentSessionId}</small></div>
              <span className="agent-live">{job.executionReady ? "ACTIVE" : "PREVIEW"}</span>
            </div>
            <ol className="agent-timeline">
              {agentSteps.map((step, index) => {
                const completed = currentStep > index || job.status === "COMPLETED";
                const active = currentStep === index && job.status !== "COMPLETED";
                return (
                  <li key={step.state} className={`${completed ? "is-complete" : ""} ${active ? "is-active" : ""}`}>
                    <span className="timeline-node">{completed ? <Check size={12} /> : String(index + 1).padStart(2, "0")}</span>
                    <div><strong>{step.label}</strong><small>{active ? job.statusReason : completed ? "완료" : "대기"}</small></div>
                  </li>
                );
              })}
            </ol>
          </section>

          <section className="panel materials-panel">
            <PanelTitle eyebrow="Blueprint palette" title="주요 자재" action={<span className="mono-count">{job.blueprint.paletteSize}종</span>} />
            <div className="materials-list">
              {job.blueprint.materials.map((material) => (
                <div className="material-row" key={material.block}>
                  <span className="material-swatch" style={{ "--swatch": material.color } as React.CSSProperties} />
                  <div><strong>{material.label}</strong><small>{material.block.replace("minecraft:", "")}</small></div>
                  <span>{material.count.toLocaleString()}</span>
                </div>
              ))}
            </div>
          </section>
        </aside>

        <section className="panel viewer-panel">
          <PanelTitle
            eyebrow={`Site viewport · X ${snapshot.origin.x} / Y ${snapshot.origin.y} / Z ${snapshot.origin.z}`}
            title="현장 미리보기"
            action={<span className="viewer-hint">드래그 회전 · 휠 확대</span>}
          />
          <div className="layer-switcher" aria-label="미리보기 레이어">
            {([
              ["existing", "현재 지형"],
              ["plan", "청사진"],
              ["difference", "차이"],
            ] as Array<[VoxelLayer, string]>).map(([value, label]) => (
              <button key={value} className={layer === value ? "is-active" : ""} type="button" onClick={() => setLayer(value)}>
                {value === "difference" && <Layers3 size={14} />}{label}
              </button>
            ))}
          </div>
          <div className="viewer-stage">
            <Suspense fallback={<div className="voxel-loading"><RefreshCw className="spin" size={20} /><span>3D 현장 렌더러 불러오는 중</span></div>}><VoxelPreview snapshot={snapshot} layer={layer} /></Suspense>
            <div className="mobile-viewer-placeholder">
              <Box size={34} strokeWidth={1.4} />
              <strong>3D 현장 뷰</strong>
              <span>태블릿 이상의 화면에서 확인할 수 있습니다.</span>
            </div>
            <div className="axis-key" aria-hidden="true"><span className="axis-x">X</span><span className="axis-y">Y</span><span className="axis-z">Z</span></div>
            <div className="viewer-bounds"><MapPin size={13} /> {job.blueprint.dimensions.x} × {job.blueprint.dimensions.y} × {job.blueprint.dimensions.z} · {server.world}</div>
          </div>
          <div className="phase-progress">
            <div className="phase-progress__top">
              <span>시공 단계</span>
              <strong>{job.progress.toFixed(1)}%</strong>
            </div>
            <div className="progress-track"><span style={{ width: `${job.progress}%` }} /></div>
            <div className="phase-list">
              {job.phases.map((phase, index) => (
                <div key={phase.id} className={`phase-item ${phase.state.toLowerCase()}`}>
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <strong>{phase.label}</strong>
                  <small>{phase.appliedBlocks.toLocaleString()} / {phase.totalBlocks.toLocaleString()}</small>
                </div>
              ))}
            </div>
          </div>
        </section>

        <aside className="right-stack">
          {job.status === "WAITING_APPROVAL" ? (
            <section className="panel approval-panel">
              <PanelTitle eyebrow="Human gate" title={job.executionReady ? "청사진 승인" : "샘플 청사진"} action={<span className="version-stamp">V{job.blueprint.planVersion}</span>} />
              <p className="approval-intent">“{job.blueprint.intent}”</p>
              <div className="risk-list">
                {job.blueprint.risks.map((risk) => (
                  <div className="risk-row" key={risk.code}>
                    <span className={`risk-icon tone-${risk.severity}`}>{risk.passed ? <Check size={12} /> : <TriangleAlert size={12} />}</span>
                    <div><strong>{risk.label}</strong><small>{risk.detail}</small></div>
                  </div>
                ))}
              </div>
              <button className="primary-button full-width" type="button" onClick={() => onModal("approve")} disabled={busyAction !== null || !job.executionReady || !server.connected || !canReview}>
                <Check size={17} /> 청사진 v{job.blueprint.planVersion} 승인
              </button>
              <div className="split-actions">
                <button className="secondary-button" type="button" onClick={() => onModal("changes")} disabled={!canReview}><MessageSquareText size={15} /> 수정 요청</button>
                <button className="ghost-danger-button" type="button" onClick={() => onModal("reject")} disabled={!canReview}><X size={15} /> 거절</button>
              </div>
              <p className="approval-note"><ShieldCheck size={13} />{!job.executionReady ? "이 샘플은 미리보기 전용입니다. AI 설계실에서 실행 가능한 청사진을 만드세요." : !server.connected ? "Paper Bridge가 다시 연결되어야 승인할 수 있습니다." : "승인 시 이 청사진 버전만 플러그인이 재검사하고 시공합니다."}</p>
            </section>
          ) : (
            <section className="panel control-panel">
              <PanelTitle eyebrow="Operator controls" title="시공 제어" action={<Command size={18} />} />
              <div className="progress-hero">
                <div className="progress-ring" style={{ "--progress": `${job.progress * 3.6}deg` } as React.CSSProperties}>
                  <span>{Math.round(job.progress)}<small>%</small></span>
                </div>
                <div><strong>{statusCopy[job.status].label}</strong><span>{job.appliedBlocks.toLocaleString()} / {job.totalBlocks.toLocaleString()}블록</span><small>ETA {formatDuration(job.etaSeconds)}</small></div>
              </div>
              <div className="control-actions">
                {job.status === "PAUSED" ? (
                  <button className="primary-button" type="button" onClick={() => void onControl("resume")} disabled={busyAction !== null || !canOperate}><Play size={17} /> 재개</button>
                ) : (
                  <button className="secondary-button" type="button" onClick={() => void onControl("pause")} disabled={busyAction !== null || !canOperate || !["BUILDING", "PAUSE_REQUESTED"].includes(job.status)}><Pause size={17} /> 일시정지</button>
                )}
                <button className="secondary-button" type="button" onClick={() => onModal("rollback")} disabled={busyAction !== null || !canOperate || job.appliedBlocks === 0}><RotateCcw size={17} /> 롤백</button>
                <button className="ghost-danger-button" type="button" onClick={() => onModal("cancel")} disabled={busyAction !== null || !canOperate || ["ROLLING_BACK", "CANCELLED"].includes(job.status)}><XCircle size={17} /> 취소</button>
              </div>
              <div className="checkpoint-row"><Database size={14} /><span>최근 체크포인트</span><strong>{job.checkpoint ?? "아직 없음"}</strong></div>
              {job.status === "PAUSE_REQUESTED" && <div className="inline-warning"><CirclePause size={15} /> 현재 배치가 끝나는 즉시 정지합니다.</div>}
            </section>
          )}

          <section className="panel event-panel">
            <PanelTitle
              eyebrow="Live event stream"
              title="이벤트"
              action={<div className="event-filter"><button className={eventFilter === "all" ? "is-active" : ""} onClick={() => setEventFilter("all")}>전체</button><button className={eventFilter === "alerts" ? "is-active" : ""} onClick={() => setEventFilter("alerts")}>경고</button></div>}
            />
            <div className="event-list">
              {visibleEvents.slice(0, 12).map((event) => (
                <article className={`event-row tone-${event.severity}`} key={event.eventId}>
                  <span className="event-row__marker" />
                  <div>
                    <div className="event-row__meta"><span>{formatTime(event.timestamp)}</span><span>#{event.sequence}</span></div>
                    <strong>{event.title}</strong>
                    <p>{event.detail}</p>
                    <small>{event.actor}</small>
                  </div>
                </article>
              ))}
              {visibleEvents.length === 0 && <div className="empty-events">표시할 경고가 없습니다.</div>}
            </div>
          </section>
        </aside>
      </div>
    </main>
  );
}

function Overview({ job, server, events, onOpenJob }: { job: BuildJob; server: ServerHealth; events: BuildEvent[]; onOpenJob: () => void }) {
  const criticalEvents = events.filter((event) => event.severity === "critical").length;
  return (
    <main className="page secondary-page">
      <section className="page-heading">
        <div><span className="eyebrow">Operations overview</span><h1>{server.connected ? "Paper 월드가 연결됐습니다" : "Paper Bridge 연결 대기 중"}</h1><p>{job.executionReady ? "실행 가능한 청사진이 사람의 결정을 기다리고 있습니다." : "현재 작업은 UI 확인용 샘플이며 실제 월드에는 적용할 수 없습니다."}</p></div>
        <div className="overview-clock"><Clock3 size={18} /><span>최근 상태 갱신</span><strong>{formatTime(server.updatedAt)}</strong></div>
      </section>
      <div className="overview-kpis">
        <article><span className="kpi-icon"><Server size={18} /></span><span>Paper Bridge</span><strong>{server.connected ? "연결됨" : "연결 끊김"}</strong><small>{server.version}</small></article>
        <article><span className="kpi-icon"><Activity size={18} /></span><span>서버 성능</span><strong>{server.connected ? `${server.tps.toFixed(2)} TPS` : "측정 대기"}</strong><small>{server.connected ? `${server.mspt.toFixed(1)} MSPT` : "Bridge 연결 필요"}</small></article>
        <article><span className="kpi-icon"><Bot size={18} /></span><span>실행 가능한 Agent</span><strong>{job.executionReady ? "1 세션" : "0 세션"}</strong><small>{job.executionReady ? job.agentName : "샘플 작업 제외"}</small></article>
        <article><span className="kpi-icon"><ShieldCheck size={18} /></span><span>중대 이벤트</span><strong>{criticalEvents.toLocaleString()} 건</strong><small>현재 이벤트 로그</small></article>
      </div>
      <div className="overview-grid">
        <section className="panel overview-build">
          <PanelTitle eyebrow="Requires attention" title={job.executionReady ? "승인 대기 작업" : "미리보기 작업"} action={<StatusTag status={job.status} preview={!job.executionReady} />} />
          <div className="overview-build__body">
            <div className="mini-plan"><Box size={48} strokeWidth={1.25} /><span>BP · V{job.blueprint.planVersion}</span></div>
            <div><h3>{job.title}</h3><p>{job.request}</p><div className="overview-build__facts"><span>{job.blueprint.changedBlocks.toLocaleString()} blocks</span><span>{job.blueprint.dimensions.x}×{job.blueprint.dimensions.y}×{job.blueprint.dimensions.z}</span><span>{job.blueprint.paletteSize} materials</span></div></div>
          </div>
          <button className="primary-button" type="button" onClick={onOpenJob}>작업 검토 <ChevronRight size={16} /></button>
        </section>
        <section className="panel server-vitals">
          <PanelTitle eyebrow="Live health" title={server.name} action={<span className={`server-compact__dot ${server.connected ? "" : "is-offline"}`} />} />
          {[{ label: "TPS", value: server.tps, max: 20, display: server.tps.toFixed(2) }, { label: "MSPT", value: server.mspt, max: 50, display: server.mspt.toFixed(1) }, { label: "메모리", value: server.memoryUsedMb, max: server.memoryTotalMb, display: `${Math.round(server.memoryUsedMb / 1024 * 10) / 10} GB` }].map((metric) => (
            <div className="vital-row" key={metric.label}><div><span>{metric.label}</span><strong>{metric.display}</strong></div><div className="metric-track"><span style={{ width: `${Math.min(100, metric.value / metric.max * 100)}%` }} /></div></div>
          ))}
          <div className="server-facts"><span>Players <strong>{server.playersOnline}</strong></span><span>Queue <strong>{server.queueDepth}</strong></span><span>World <strong>{server.world}</strong></span></div>
        </section>
        <section className="panel overview-events">
          <PanelTitle eyebrow="Recent activity" title="최근 이벤트" action={<FileClock size={18} />} />
          {events.slice(0, 5).map((event) => <div className="compact-event" key={event.eventId}><span className={`tone-dot tone-${event.severity}`} /><div><strong>{event.title}</strong><small>{event.detail}</small></div><time>{formatTime(event.timestamp)}</time></div>)}
        </section>
      </div>
    </main>
  );
}

function WorldScreen({ job, server }: { job: BuildJob; server: ServerHealth }) {
  return (
    <main className="page secondary-page">
      <section className="page-heading"><div><span className="eyebrow">BlueMap live world</span><h1>실제 월드 지도</h1><p>Paper 서버의 실제 월드 타일을 BlueMap 3D로 표시합니다.</p></div><div className="map-coordinate"><MapPin size={16} /> {server.world} · {server.connected ? "LIVE" : "LAST RENDER"}</div></section>
      <section className="panel world-map-panel">
        <div className="map-toolbar"><div><span className="map-live-dot" />{server.world} · BlueMap 3D</div><a className="map-open-link" href="/live-map/" target="_blank" rel="noreferrer">전체 화면으로 열기 <ChevronRight size={14} /></a></div>
        <div className="world-map-frame"><iframe src="/live-map/" title={`${server.world} 실제 BlueMap 월드 지도`} loading="eager" allowFullScreen /></div>
        <div className="map-footer"><span><i className="legend-build" /> 현재 청사진 v{job.blueprint.planVersion}</span><span><i className="legend-player" /> 온라인 {server.playersOnline}명</span><small>서버 월드 데이터로 렌더링 · 지도 갱신에는 잠시 시간이 걸릴 수 있습니다.</small></div>
      </section>
    </main>
  );
}

function AgentsScreen({
  job,
  server,
  status,
  busy,
  onGenerate,
  onOpenJob,
  canOperate,
}: {
  job: BuildJob;
  server: ServerHealth;
  status: ArchitectStatus | null;
  busy: boolean;
  onGenerate: (input: ArchitectRequest) => Promise<ArchitectReply>;
  onOpenJob: () => void;
  canOperate: boolean;
}) {
  const [messages, setMessages] = useState<ArchitectMessage[]>([
    { role: "assistant", content: "원하는 건축물의 크기, 분위기, 재료를 말해 주세요. 참고 이미지를 함께 올리면 형태와 색감을 마인크래프트 블록으로 해석해 청사진을 만듭니다." },
  ]);
  const [draft, setDraft] = useState("");
  const [image, setImage] = useState<{ name: string; dataUrl: string } | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [publishedVersion, setPublishedVersion] = useState<number | null>(null);
  const [target, setTarget] = useState({
    world: server.world,
    x: String(job.blueprint.bounds.min.x),
    y: String(job.blueprint.bounds.min.y),
    z: String(job.blueprint.bounds.min.z),
  });

  const handleImage = async (file: File | undefined) => {
    setLocalError(null);
    if (!file) return;
    if (!(["image/png", "image/jpeg", "image/webp"] as string[]).includes(file.type)) {
      setLocalError("PNG, JPG 또는 WEBP 이미지만 올릴 수 있습니다.");
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      setLocalError("이미지는 8MB 이하여야 합니다.");
      return;
    }
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error("이미지를 읽지 못했습니다."));
      reader.readAsDataURL(file);
    });
    setImage({ name: file.name, dataUrl });
  };

  const submit = async () => {
    const message = draft.trim();
    if (!message || busy || !status?.configured || !canOperate) return;
    const coordinates = [target.x, target.y, target.z].map(Number);
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(target.world.trim())) {
      setLocalError("월드 이름은 영문, 숫자, 밑줄, 하이픈만 사용할 수 있습니다.");
      return;
    }
    if (!coordinates.every(Number.isSafeInteger)) {
      setLocalError("시공 원점의 X, Y, Z는 정수여야 합니다.");
      return;
    }
    const history = messages.slice(-11);
    setMessages((current) => [...current, { role: "user", content: message }]);
    setDraft("");
    setLocalError(null);
    try {
      const reply = await onGenerate({
        message,
        history,
        imageDataUrl: image?.dataUrl,
        target: { world: target.world.trim(), origin: { x: coordinates[0]!, y: coordinates[1]!, z: coordinates[2]! } },
      });
      setMessages((current) => [...current, { role: "assistant", content: reply.assistantMessage }]);
      setImage(null);
      setPublishedVersion(reply.job?.blueprint.planVersion ?? null);
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : "AI 설계 요청에 실패했습니다.");
    }
  };

  return (
    <main className="page secondary-page">
      <section className="page-heading"><div><span className="eyebrow">AI blueprint studio</span><h1>AI 설계실</h1><p>대화와 참고 이미지를 실제 블록 청사진으로 바꾸고, 검토 후 승인 대기열에 게시합니다.</p></div><span className={`architect-status ${status?.configured ? "is-ready" : ""}`}><i />{status?.configured ? `${status.model} 연결됨` : "API 키 설정 대기"}</span></section>
      <section className="panel architect-studio">
        <div className="architect-studio__header"><div><span className="agent-glyph"><Sparkles size={17} /></span><div><strong>Quarry Architect</strong><small>이미지 이해 · 블록 설계 · 승인 전용</small></div></div><span>WORLD WRITE: LOCKED</span></div>
        <div className="architect-chat" aria-live="polite">
          {messages.map((message, index) => <article className={`architect-message is-${message.role}`} key={`${message.role}-${index}`}><span>{message.role === "assistant" ? "QA" : "YOU"}</span><p>{message.content}</p></article>)}
          {busy && <article className="architect-message is-assistant is-thinking"><span>QA</span><p>이미지를 분석하고 블록 단위 청사진을 계산하고 있습니다…</p></article>}
        </div>
        {!status?.configured && <div className="architect-notice"><TriangleAlert size={16} /><div><strong>서버 API 키가 아직 없습니다.</strong><p>Admin은 설정 화면에서 키를 암호화 저장하거나 서버의 <code>OPENAI_API_KEY</code> 환경변수로 설정할 수 있습니다. 저장된 키 원문은 브라우저로 다시 전송되지 않습니다.</p></div></div>}
        {publishedVersion && <div className="architect-published"><Check size={16} /><span>청사진 v{publishedVersion}이 승인 대기열에 게시되었습니다.</span><button type="button" onClick={onOpenJob}>검토하기 <ChevronRight size={14} /></button></div>}
        {localError && <div className="architect-error" role="alert"><TriangleAlert size={15} />{localError}</div>}
        {image && <div className="architect-attachment"><img src={image.dataUrl} alt="업로드한 건축 참고 이미지 미리보기" /><span>{image.name}</span><button type="button" onClick={() => setImage(null)} aria-label="첨부 이미지 제거"><X size={14} /></button></div>}
        <fieldset className="architect-target"><legend>실제 시공 원점</legend><label><span>월드</span><input value={target.world} onChange={(event) => setTarget((current) => ({ ...current, world: event.target.value }))} maxLength={64} /></label><label><span>X</span><input inputMode="numeric" value={target.x} onChange={(event) => setTarget((current) => ({ ...current, x: event.target.value }))} /></label><label><span>Y</span><input inputMode="numeric" value={target.y} onChange={(event) => setTarget((current) => ({ ...current, y: event.target.value }))} /></label><label><span>Z</span><input inputMode="numeric" value={target.z} onChange={(event) => setTarget((current) => ({ ...current, z: event.target.value }))} /></label><small>이 좌표는 건축물 중심 바닥 기준입니다. 승인 시 Paper 플러그인이 허용 영역·플레이어 거리·TPS를 다시 검사합니다.</small></fieldset>
        <div className="architect-composer">
          <textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") void submit(); }} placeholder="예: 이 사진의 지붕과 창문 형태를 살려 24×18 크기의 2층 산장으로 설계해줘" maxLength={4000} aria-label="AI 건축 설계 요청" disabled={!canOperate} />
          <div className="architect-composer__actions"><label className="attachment-button"><ImagePlus size={17} /><span>참고 이미지</span><input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => void handleImage(event.target.files?.[0])} disabled={!canOperate} /></label><small>{draft.length.toLocaleString()} / 4,000 · Ctrl/⌘ + Enter</small><button className="primary-button" type="button" onClick={() => void submit()} disabled={!draft.trim() || busy || !status?.configured || !canOperate}>{busy ? <RefreshCw className="spin" size={16} /> : <Send size={16} />}설계 요청</button></div>
        </div>
      </section>
      <section className="panel agent-directory">
        <div className="agent-directory__head"><span>AGENT</span><span>STATE</span><span>PERMISSION</span><span>LAST ACTION</span></div>
        <div className="agent-directory__row"><div className="directory-agent"><span className="agent-glyph"><Sparkles size={17} /></span><div><strong>{job.agentName}</strong><small>{job.agentSessionId}</small></div></div><StatusTag status={job.status} preview={!job.executionReady} /><span className="permission-badge"><ShieldCheck size={14} /> Scoped write</span><div><strong>청사진 v{job.blueprint.planVersion} 게시</strong><small>{formatTime(job.updatedAt)}</small></div></div>
        <div className="agent-permissions"><h3>현재 세션 경계</h3><div><span>서버</span><strong>{job.serverId}</strong></div><div><span>월드</span><strong>{server.world}</strong></div><div><span>영역</span><strong>{job.blueprint.dimensions.x} × {job.blueprint.dimensions.y} × {job.blueprint.dimensions.z}</strong></div><div><span>배치 제한</span><strong>250 blocks</strong></div></div>
      </section>
    </main>
  );
}

function AuditScreen({ events }: { events: BuildEvent[] }) {
  return (
    <main className="page secondary-page">
      <section className="page-heading"><div><span className="eyebrow">Immutable operations record</span><h1>감사 로그</h1><p>승인, 정책 판단, 명령과 상태 변경을 sequence 순서로 추적합니다.</p></div><button className="secondary-button"><RefreshCw size={15} /> 새로고침</button></section>
      <section className="panel audit-table-wrap">
        <table className="audit-table"><thead><tr><th>SEQUENCE</th><th>시간</th><th>행위자</th><th>이벤트</th><th>결과</th></tr></thead><tbody>{events.map((event) => <tr key={event.eventId}><td className="mono-count">#{event.sequence}</td><td>{formatTime(event.timestamp)}</td><td>{event.actor}</td><td><strong>{event.title}</strong><small>{event.detail}</small></td><td><span className={`audit-result tone-${event.severity}`}>{event.severity === "critical" ? "BLOCKED" : "RECORDED"}</span></td></tr>)}</tbody></table>
      </section>
    </main>
  );
}

function SettingsScreen({ status, busy, canManageKey, onSaveKey, onRemoveKey }: { status: ArchitectStatus | null; busy: boolean; canManageKey: boolean; onSaveKey: (key: string) => Promise<ArchitectStatus>; onRemoveKey: () => Promise<ArchitectStatus> }) {
  const [apiKey, setApiKey] = useState("");
  const [keyMessage, setKeyMessage] = useState<string | null>(null);
  const [keyError, setKeyError] = useState<string | null>(null);
  const policies = [
    ["모든 쓰기 수동 승인", "신규 및 변경된 청사진은 Reviewer 승인이 필요합니다.", true],
    ["플레이어 접근 자동 정지", "24블록 이내 접근 시 다음 체크포인트에서 정지합니다.", true],
    ["성능 임계 자동 정지", "TPS가 18 미만이거나 MSPT가 40을 넘으면 다음 배치를 시작하지 않습니다.", true],
    ["야간 자동 시공", "예약된 시간에 승인 작업을 자동 시작합니다.", false],
  ] as const;
  return (
    <main className="page secondary-page">
      <section className="page-heading"><div><span className="eyebrow">Safety policy</span><h1>운영 설정</h1><p>서버 비밀 설정은 Admin 역할에서만 변경할 수 있습니다.</p></div><span className="permission-badge"><ShieldCheck size={14} /> {canManageKey ? "Admin · 변경 가능" : "읽기 전용"}</span></section>
      <section className="panel api-key-panel">
        <PanelTitle eyebrow="Server-side secret" title="OpenAI API 키" action={<KeyRound size={18} />} />
        <p>키는 HTTPS로 Gateway에만 전달되고, 서버의 암호화 저장소에 보관됩니다. 브라우저 저장소와 화면 응답에는 키 원문이 남지 않습니다.</p>
        <div className="api-key-state"><span className={`architect-status ${status?.configured ? "is-ready" : ""}`}><i />{status?.configured ? `${status.model} 연결됨` : "키 미설정"}</span><small>{status?.source === "environment" ? "환경변수에서 관리 중" : status?.source === "encrypted-store" ? "서버 암호화 저장소" : "설정 필요"}</small></div>
        <form onSubmit={(event) => { event.preventDefault(); setKeyError(null); setKeyMessage(null); void onSaveKey(apiKey).then(() => { setApiKey(""); setKeyMessage("API 키를 안전하게 저장했습니다."); }).catch((error) => setKeyError(error instanceof Error ? error.message : "API 키 저장에 실패했습니다.")); }}>
          <label><span>새 API 키</span><input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="sk-…" autoComplete="off" spellCheck={false} minLength={24} maxLength={512} disabled={busy || !canManageKey || status?.source === "environment"} /></label>
          <div className="api-key-actions"><button className="primary-button" type="submit" disabled={busy || !canManageKey || apiKey.trim().length < 24 || status?.source === "environment"}>{busy ? <RefreshCw className="spin" size={16} /> : <KeyRound size={16} />}암호화 저장</button>{status?.source === "encrypted-store" && <button className="secondary-button" type="button" disabled={busy || !canManageKey} onClick={() => { setKeyError(null); setKeyMessage(null); void onRemoveKey().then(() => setKeyMessage("저장된 API 키를 삭제했습니다.")).catch((error) => setKeyError(error instanceof Error ? error.message : "API 키 삭제에 실패했습니다.")); }}><Trash2 size={16} />키 삭제</button>}</div>
        </form>
        {keyMessage && <div className="architect-published" role="status"><Check size={16} />{keyMessage}</div>}
        {keyError && <div className="architect-error" role="alert"><TriangleAlert size={15} />{keyError}</div>}
      </section>
      <div className="settings-grid">
        <section className="panel policy-panel"><PanelTitle eyebrow="Guardrails" title="시공 정책" action={<ShieldCheck size={18} />} />{policies.map(([title, detail, enabled]) => <div className="policy-row" key={title}><div><strong>{title}</strong><small>{detail}</small></div><span className={`toggle ${enabled ? "is-on" : ""}`}><i /></span></div>)}</section>
        <section className="panel limits-panel"><PanelTitle eyebrow="Hard limits" title="월드 변경 한도" action={<Database size={18} />} /><label>최대 청사진 블록<strong>12,000</strong></label><label>배치당 최대 블록<strong>250</strong></label><label>최소 서버 TPS<strong>18.0</strong></label><label>최대 MSPT<strong>40 ms</strong></label><label>Rollback diff<strong>서버에 보존</strong></label></section>
      </div>
    </main>
  );
}

function LoginScreen({ busy, onLogin }: { busy: boolean; onLogin: (password: string) => Promise<void> }) {
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState<string | null>(null);
  return (
    <main className="login-screen">
      <section className="login-card">
        <span className="boot-mark"><Box size={26} /></span>
        <span className="eyebrow">Protected control plane</span>
        <h1>Quarry 관리자 로그인</h1>
        <p>월드 제어와 API 키 설정은 인증된 관리자 세션에서만 사용할 수 있습니다.</p>
        <form onSubmit={(event) => { event.preventDefault(); setLoginError(null); void onLogin(password).catch((error) => setLoginError(error instanceof Error ? error.message : "로그인에 실패했습니다.")); }}>
          <label><span>관리자 비밀번호</span><input autoFocus type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} maxLength={512} /></label>
          {loginError && <div className="architect-error" role="alert"><TriangleAlert size={15} />{loginError}</div>}
          <button className="primary-button" type="submit" disabled={busy || !password}>{busy ? <RefreshCw className="spin" size={16} /> : <KeyRound size={16} />}로그인</button>
        </form>
      </section>
    </main>
  );
}

function ActionModal({ kind, job, busy, comment, onComment, onClose, onConfirm }: { kind: ModalKind; job: BuildJob; busy: boolean; comment: string; onComment: (value: string) => void; onClose: () => void; onConfirm: () => void }) {
  if (!kind) return null;
  const content = {
    approve: { icon: <ShieldCheck size={22} />, title: `청사진 v${job.blueprint.planVersion}을 승인할까요?`, detail: "현재 영역 해시를 다시 확인한 뒤 250블록 단위로 시공을 시작합니다.", confirm: "승인하고 시공", danger: false },
    changes: { icon: <MessageSquareText size={22} />, title: "수정 요청 보내기", detail: "현재 승인은 무효 상태로 유지되며 Agent가 새 청사진 버전을 게시합니다.", confirm: "수정 요청", danger: false },
    reject: { icon: <XCircle size={22} />, title: "청사진을 거절할까요?", detail: "작업은 취소되고 예약된 부지가 해제됩니다.", confirm: "거절", danger: true },
    rollback: { icon: <RotateCcw size={22} />, title: "원본 상태로 롤백할까요?", detail: `${job.appliedBlocks.toLocaleString()}개 변경 블록을 체크포인트 역순으로 복구합니다. 외부 변경은 덮어쓰지 않습니다.`, confirm: "롤백 시작", danger: true },
    cancel: { icon: <XCircle size={22} />, title: "시공을 취소할까요?", detail: "새 배치를 중단하고 지금까지의 변경을 원본 스냅샷으로 복구합니다.", confirm: "취소 및 복구", danger: true },
  }[kind];
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="action-modal-title">
        <button className="modal-close icon-button" type="button" onClick={onClose} title="닫기"><X size={18} /></button>
        <span className={`modal-icon ${content.danger ? "is-danger" : ""}`}>{content.icon}</span>
        <h2 id="action-modal-title">{content.title}</h2>
        <p>{content.detail}</p>
        {(kind === "approve" || kind === "changes" || kind === "reject") && <label className="comment-field"><span>{kind === "changes" ? "수정 지시" : "결정 메모"}</span><textarea autoFocus={kind === "changes"} value={comment} onChange={(event) => onComment(event.target.value)} placeholder={kind === "changes" ? "예: 동쪽 출입구를 두 블록 남쪽으로 이동" : "감사 로그에 남길 메모 (선택)"} /></label>}
        {kind === "rollback" && <div className="rollback-summary"><span>대상</span><strong>전체 작업 · {job.checkpoint ?? "초기"}</strong><span>예상 시간</span><strong>{formatDuration(Math.ceil(job.appliedBlocks / 310))}</strong></div>}
        <div className="modal-actions"><button className="secondary-button" type="button" onClick={onClose}>돌아가기</button><button className={content.danger ? "danger-button" : "primary-button"} type="button" onClick={onConfirm} disabled={busy || (kind === "changes" && comment.trim().length < 3)}>{busy && <RefreshCw className="spin" size={16} />}{content.confirm}</button></div>
      </section>
    </div>
  );
}

export default function App() {
  const controlCenter = useControlCenter();
  const [activeNav, setActiveNav] = useState<NavKey>("jobs");
  const [theme, setTheme] = useState<"light" | "dark">(() => (localStorage.getItem("quarry-theme") as "light" | "dark" | null) ?? "dark");
  const [modal, setModal] = useState<ModalKind>(null);
  const [comment, setComment] = useState("");

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("quarry-theme", theme);
  }, [theme]);

  const modalBusy = controlCenter.busyAction !== null;
  const canRender = controlCenter.job && controlCenter.server && controlCenter.snapshot;

  const handleConfirm = async () => {
    if (!modal) return;
    try {
      if (modal === "approve" || modal === "changes" || modal === "reject") {
        await controlCenter.approve(modal === "approve" ? "approved" : modal === "changes" ? "changes_requested" : "rejected", comment);
      } else {
        await controlCenter.control(modal);
      }
      setModal(null);
      setComment("");
    } catch {
      // Error state is rendered in the application shell.
    }
  };

  const screen = useMemo(() => {
    const { job, server, snapshot, events } = controlCenter;
    if (!job || !server || !snapshot) return null;
    switch (activeNav) {
      case "overview": return <Overview job={job} server={server} events={events} onOpenJob={() => setActiveNav("jobs")} />;
      case "world": return <WorldScreen job={job} server={server} />;
      case "agents": return <AgentsScreen job={job} server={server} status={controlCenter.architectStatus} busy={controlCenter.busyAction === "architect"} canOperate={roleAtLeast(controlCenter.session?.role, "Operator")} onGenerate={controlCenter.askArchitect} onOpenJob={() => setActiveNav("jobs")} />;
      case "audit": return <AuditScreen events={events} />;
      case "settings": return <SettingsScreen status={controlCenter.architectStatus} busy={controlCenter.busyAction === "openai-key"} canManageKey={controlCenter.session?.role === "Admin"} onSaveKey={controlCenter.saveOpenAiKey} onRemoveKey={controlCenter.removeOpenAiKey} />;
      case "jobs": return <BuildDetail job={job} server={server} events={events} snapshot={snapshot} busyAction={controlCenter.busyAction} canReview={roleAtLeast(controlCenter.session?.role, "Reviewer")} canOperate={roleAtLeast(controlCenter.session?.role, "Operator")} onModal={setModal} onControl={controlCenter.control} />;
    }
  }, [activeNav, canRender, controlCenter]);

  if (controlCenter.loading) {
    return <div className="boot-screen"><span className="boot-mark"><Box size={26} /></span><strong>Quarry</strong><p>Gateway 상태와 현장 스냅샷을 동기화하고 있습니다.</p><span className="boot-line" /></div>;
  }

  if (!controlCenter.session) {
    return <LoginScreen busy={controlCenter.busyAction === "login"} onLogin={controlCenter.login} />;
  }

  if (!canRender) {
    return <div className="boot-screen is-error"><span className="boot-mark"><TriangleAlert size={26} /></span><strong>Gateway에 연결할 수 없습니다</strong><p>{controlCenter.error ?? "서비스가 실행 중인지 확인하세요."}</p><code>npm run dev</code><button className="primary-button" onClick={() => void controlCenter.reload()}><RefreshCw size={16} /> 다시 연결</button></div>;
  }

  return (
    <div className="app-shell">
      <Navigation active={activeNav} onChange={setActiveNav} actor={controlCenter.session.actor} role={controlCenter.session.role} onLogout={() => void controlCenter.logout()} />
      <div className="app-main">
        <TopBar active={activeNav} server={controlCenter.server!} connection={controlCenter.connection} theme={theme} onTheme={() => setTheme((current) => current === "dark" ? "light" : "dark")} onLogout={() => void controlCenter.logout()} />
        {controlCenter.error && <div className="global-alert" role="alert"><TriangleAlert size={15} /><span>{controlCenter.error}</span><button onClick={controlCenter.dismissError} title="알림 닫기"><X size={15} /></button></div>}
        {screen}
      </div>
      <ActionModal kind={modal} job={controlCenter.job!} busy={modalBusy} comment={comment} onComment={setComment} onClose={() => { setModal(null); setComment(""); }} onConfirm={() => void handleConfirm()} />
    </div>
  );
}
