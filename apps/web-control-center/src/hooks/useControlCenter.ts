import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ApprovalRecord,
  ArchitectReply,
  ArchitectRequest,
  ArchitectStatus,
  BuildEvent,
  BuildJob,
  EventEnvelope,
  ServerHealth,
  SiteSnapshot,
  WsEventPayload,
} from "@dynamic-ai/protocol";
import { ApiError, request, setCsrfToken, WS_URL } from "../lib/api";

type ConnectionState = "connecting" | "live" | "reconnecting" | "offline";

export interface AuthSession {
  authenticated: true;
  actor: string;
  role: "Viewer" | "Reviewer" | "Operator" | "Admin";
  serverId: string;
  hostedTenant: boolean;
  csrfToken: string;
  expiresAt: string;
}

export function useControlCenter() {
  const [session, setSession] = useState<AuthSession | null | undefined>(undefined);
  const [job, setJob] = useState<BuildJob | null>(null);
  const [server, setServer] = useState<ServerHealth | null>(null);
  const [events, setEvents] = useState<BuildEvent[]>([]);
  const [snapshot, setSnapshot] = useState<SiteSnapshot | null>(null);
  const [architectStatus, setArchitectStatus] = useState<ArchitectStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const lastSequence = useRef(0);

  const load = useCallback(async () => {
    try {
      const jobs = await request<BuildJob[]>("/api/v1/builds");
      const active = jobs[0];
      if (!active) throw new Error("표시할 건축 작업이 없습니다.");
      const [nextServer, nextEvents, nextSnapshot, nextArchitectStatus] = await Promise.all([
        request<ServerHealth>(`/api/v1/servers/${active.serverId}/status`),
        request<BuildEvent[]>(`/api/v1/builds/${active.buildId}/events`),
        request<SiteSnapshot>(`/api/v1/builds/${active.buildId}/site-snapshot`),
        request<ArchitectStatus>("/api/v1/architect/status"),
      ]);
      lastSequence.current = Math.max(active.sequence, ...nextEvents.map((event) => event.sequence));
      setJob(active);
      setServer(nextServer);
      setEvents([...nextEvents].reverse());
      setSnapshot(nextSnapshot);
      setArchitectStatus(nextArchitectStatus);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Gateway에 연결할 수 없습니다.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const bootstrap = async () => {
      try {
        const authenticated = await request<AuthSession>("/api/v1/auth/session");
        if (cancelled) return;
        setCsrfToken(authenticated.csrfToken);
        setSession(authenticated);
        await load();
      } catch (bootstrapError) {
        if (cancelled) return;
        if (bootstrapError instanceof ApiError && bootstrapError.status === 401) {
          setCsrfToken(null);
          setSession(null);
          setLoading(false);
          setError(null);
          return;
        }
        setError(bootstrapError instanceof Error ? bootstrapError.message : "Gateway에 연결할 수 없습니다.");
        setLoading(false);
      }
    };
    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, [load]);

  useEffect(() => {
    if (loading || error || !session) return;
    let socket: WebSocket | null = null;
    let reconnectTimer: number | undefined;
    let stopped = false;

    const connect = () => {
      setConnection(lastSequence.current ? "reconnecting" : "connecting");
      socket = new WebSocket(`${WS_URL}/events?afterSequence=${lastSequence.current}`);
      socket.addEventListener("open", () => setConnection("live"));
      socket.addEventListener("message", (message) => {
        const envelope = JSON.parse(message.data as string) as EventEnvelope<WsEventPayload>;
        if (envelope.sequence <= lastSequence.current) return;
        lastSequence.current = envelope.sequence;
        setJob(envelope.payload.job);
        setServer(envelope.payload.server);
        if (envelope.payload.event.type !== "server.health.updated") {
          setEvents((current) => [envelope.payload.event, ...current].slice(0, 80));
        }
      });
      socket.addEventListener("close", () => {
        if (stopped) return;
        setConnection("reconnecting");
        reconnectTimer = window.setTimeout(connect, 1_500);
      });
      socket.addEventListener("error", () => socket?.close());
    };

    connect();
    return () => {
      stopped = true;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [error, loading, session]);

  const login = useCallback(async (password: string, serverId = "") => {
    setBusyAction("login");
    setError(null);
    try {
      const authenticated = await request<AuthSession>("/api/v1/auth/login", {
        method: "POST",
        body: JSON.stringify({ password, ...(serverId.trim() ? { serverId: serverId.trim() } : {}) }),
      });
      setCsrfToken(authenticated.csrfToken);
      setSession(authenticated);
      setLoading(true);
      await load();
    } finally {
      setBusyAction(null);
    }
  }, [load]);

  const claim = useCallback(async (input: { serverId: string; claimCode: string; password: string; displayName: string }) => {
    setBusyAction("claim");
    setError(null);
    try {
      const authenticated = await request<AuthSession>("/api/v1/public/servers/claim", {
        method: "POST",
        body: JSON.stringify(input),
      });
      setCsrfToken(authenticated.csrfToken);
      setSession(authenticated);
      setLoading(true);
      await load();
    } finally {
      setBusyAction(null);
    }
  }, [load]);

  const logout = useCallback(async () => {
    setBusyAction("logout");
    try {
      await request<{ authenticated: false }>("/api/v1/auth/logout", { method: "POST", body: "{}" });
    } finally {
      setCsrfToken(null);
      setSession(null);
      setJob(null);
      setServer(null);
      setSnapshot(null);
      setEvents([]);
      setBusyAction(null);
    }
  }, []);

  const saveOpenAiKey = useCallback(async (apiKey: string) => {
    setBusyAction("openai-key");
    try {
      const status = await request<ArchitectStatus>("/api/v1/settings/openai-key", {
        method: "POST",
        body: JSON.stringify({ apiKey }),
      });
      setArchitectStatus(status);
      setError(null);
      return status;
    } finally {
      setBusyAction(null);
    }
  }, []);

  const removeOpenAiKey = useCallback(async () => {
    setBusyAction("openai-key");
    try {
      const status = await request<ArchitectStatus>("/api/v1/settings/openai-key", { method: "DELETE" });
      setArchitectStatus(status);
      setError(null);
      return status;
    } finally {
      setBusyAction(null);
    }
  }, []);

  const approve = useCallback(async (decision: ApprovalRecord["decision"], comment: string) => {
    if (!job) return;
    setBusyAction(decision);
    try {
      const result = await request<{ approval: ApprovalRecord; job: BuildJob }>(`/api/v1/builds/${job.buildId}/approvals`, {
        method: "POST",
        body: JSON.stringify({ decision, comment, planVersion: job.blueprint.planVersion, actor: "서윤 · Operator" }),
      });
      setJob(result.job);
      setError(null);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "승인 요청에 실패했습니다.");
      throw actionError;
    } finally {
      setBusyAction(null);
    }
  }, [job]);

  const control = useCallback(async (action: "pause" | "resume" | "cancel" | "rollback") => {
    if (!job) return;
    setBusyAction(action);
    try {
      const nextJob = await request<BuildJob>(`/api/v1/builds/${job.buildId}/${action}`, {
        method: "POST",
        body: JSON.stringify({ actor: "서윤 · Operator" }),
      });
      setJob(nextJob);
      setError(null);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "제어 요청에 실패했습니다.");
      throw actionError;
    } finally {
      setBusyAction(null);
    }
  }, [job]);

  const askArchitect = useCallback(async (input: ArchitectRequest) => {
    setBusyAction("architect");
    try {
      const result = await request<ArchitectReply>("/api/v1/architect/messages", {
        method: "POST",
        body: JSON.stringify(input),
      });
      if (result.job) setJob(result.job);
      if (result.snapshot) setSnapshot(result.snapshot);
      setError(null);
      return result;
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "AI 설계 요청에 실패했습니다.");
      throw actionError;
    } finally {
      setBusyAction(null);
    }
  }, []);

  return {
    session,
    job,
    server,
    events,
    snapshot,
    architectStatus,
    loading,
    error,
    connection,
    busyAction,
    reload: load,
    login,
    claim,
    logout,
    approve,
    control,
    askArchitect,
    saveOpenAiKey,
    removeOpenAiKey,
    dismissError: () => setError(null),
  };
}
