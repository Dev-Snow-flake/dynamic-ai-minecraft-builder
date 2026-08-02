package dev.dynamicai.bridge;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.bukkit.World;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.WebSocket;
import java.time.Duration;
import java.time.Instant;
import java.util.UUID;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.atomic.AtomicBoolean;

final class BridgeClient implements WebSocket.Listener {
    private static final int MAX_MESSAGE_CHARS = 4 * 1024 * 1024;

    private final DynamicAiBridgePlugin plugin;
    private final URI gatewayUri;
    private final String secret;
    private final String serverId;
    private final long reconnectDelayTicks;
    private final HttpClient httpClient;
    private final StringBuilder incoming = new StringBuilder();
    private volatile WebSocket socket;
    private volatile boolean closing;
    private final AtomicBoolean reconnectScheduled = new AtomicBoolean();

    BridgeClient(
        DynamicAiBridgePlugin plugin,
        URI gatewayUri,
        String secret,
        String serverId,
        long reconnectDelayTicks
    ) {
        this.plugin = plugin;
        this.gatewayUri = gatewayUri;
        this.secret = secret;
        this.serverId = serverId;
        this.reconnectDelayTicks = reconnectDelayTicks;
        this.httpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(8))
            .build();
    }

    void connect() {
        if (closing) return;
        httpClient.newWebSocketBuilder()
            .connectTimeout(Duration.ofSeconds(8))
            .header("Authorization", "Bearer " + secret)
            .buildAsync(gatewayUri, this)
            .whenComplete((webSocket, error) -> {
                if (error != null) {
                    plugin.getLogger().warning("Gateway connection failed: " + error.getMessage());
                    scheduleReconnect();
                    return;
                }
                socket = webSocket;
            });
    }

    @Override
    public void onOpen(WebSocket webSocket) {
        socket = webSocket;
        reconnectScheduled.set(false);
        plugin.getLogger().info("Connected to Dynamic AI Gateway at " + gatewayUri);
        String register = """
            {"protocolVersion":1,"type":"bridge.register","messageId":"%s","serverId":"%s","timestamp":"%s"}
            """.formatted(UUID.randomUUID(), escape(serverId), Instant.now());
        webSocket.sendText(register.strip(), true);
        webSocket.request(1);
    }

    @Override
    public CompletionStage<?> onText(WebSocket webSocket, CharSequence data, boolean last) {
        if (incoming.length() + data.length() > MAX_MESSAGE_CHARS) {
            incoming.setLength(0);
            webSocket.sendClose(WebSocket.NORMAL_CLOSURE, "message too large");
            return null;
        }
        incoming.append(data);
        if (last) {
            String message = incoming.toString();
            incoming.setLength(0);
            handleMessage(message);
        }
        webSocket.request(1);
        return null;
    }

    @Override
    public CompletionStage<?> onClose(WebSocket webSocket, int statusCode, String reason) {
        socket = null;
        plugin.onBridgeDisconnected();
        if (!closing) {
            plugin.getLogger().warning("Gateway closed the bridge (" + statusCode + "): " + reason);
            scheduleReconnect();
        }
        return null;
    }

    @Override
    public void onError(WebSocket webSocket, Throwable error) {
        socket = null;
        plugin.onBridgeDisconnected();
        if (!closing) {
            plugin.getLogger().warning("Bridge socket error: " + error.getMessage());
            scheduleReconnect();
        }
    }

    void close() {
        closing = true;
        WebSocket activeSocket = socket;
        if (activeSocket != null) {
            activeSocket.sendClose(WebSocket.NORMAL_CLOSURE, "plugin disabled");
        }
        httpClient.close();
    }

    private void handleMessage(String message) {
        JsonObject root;
        try {
            root = JsonParser.parseString(message).getAsJsonObject();
        } catch (Exception error) {
            return;
        }
        if (!root.has("type") || !"command".equals(root.get("type").getAsString())) return;
        String method = root.has("method") ? root.get("method").getAsString() : "";
        String messageId = root.has("messageId") ? root.get("messageId").getAsString() : "";

        if ("server.get_status".equals(method)) {
            // Bukkit/Paper world access remains on the server thread.
            plugin.getServer().getScheduler().runTask(plugin, () -> sendStatus(messageId));
            return;
        }
        if (method.startsWith("build.")) {
            JsonObject payload = root.has("payload") && root.get("payload").isJsonObject()
                ? root.getAsJsonObject("payload")
                : new JsonObject();
            plugin.getServer().getScheduler().runTask(plugin, () -> plugin.handleBuildCommand(method, payload, messageId));
            return;
        }

        sendResponse(messageId, false, "METHOD_NOT_ALLOWED", "지원하지 않는 제한 도구입니다.", new JsonObject());
    }

    private void sendStatus(String correlationId) {
        double[] tpsSamples = plugin.getServer().getTPS();
        double mspt = plugin.getServer().getAverageTickTime();
        JsonObject data = new JsonObject();
        data.addProperty("version", plugin.getServer().getVersion());
        data.addProperty("tps", tpsSamples[0]);
        data.addProperty("mspt", mspt);
        data.addProperty("playersOnline", plugin.getServer().getOnlinePlayers().size());
        Runtime runtime = Runtime.getRuntime();
        data.addProperty("memoryUsedMb", (runtime.totalMemory() - runtime.freeMemory()) / (1024.0 * 1024.0));
        data.addProperty("memoryTotalMb", runtime.maxMemory() / (1024.0 * 1024.0));
        JsonArray worlds = new JsonArray();
        plugin.getServer().getWorlds().stream().map(World::getName).forEach(worlds::add);
        data.add("worlds", worlds);
        JsonObject build = plugin.buildStatus();
        if (build != null) data.add("build", build);
        sendResponse(correlationId, true, "OK", "server status", data);
    }

    void sendResponse(String correlationId, boolean ok, String code, String message, JsonObject data) {
        WebSocket activeSocket = socket;
        if (activeSocket == null) return;
        JsonObject payload = new JsonObject();
        payload.addProperty("ok", ok);
        payload.addProperty("code", code);
        payload.addProperty("message", message);
        payload.add("data", data);
        payload.addProperty("retryable", false);
        activeSocket.sendText(envelope("response", correlationId, payload).toString(), true);
    }

    void sendEvent(JsonObject payload) {
        WebSocket activeSocket = socket;
        if (activeSocket != null) activeSocket.sendText(envelope("event", null, payload).toString(), true);
    }

    boolean isOpen() {
        WebSocket activeSocket = socket;
        return activeSocket != null && !activeSocket.isOutputClosed();
    }

    private JsonObject envelope(String type, String correlationId, JsonObject payload) {
        JsonObject root = new JsonObject();
        root.addProperty("protocolVersion", 1);
        root.addProperty("type", type);
        root.addProperty("messageId", UUID.randomUUID().toString());
        if (correlationId != null) root.addProperty("correlationId", correlationId);
        root.addProperty("serverId", serverId);
        root.addProperty("timestamp", Instant.now().toString());
        root.add("payload", payload);
        return root;
    }

    private void scheduleReconnect() {
        if (closing || !reconnectScheduled.compareAndSet(false, true)) return;
        plugin.getServer().getScheduler().runTaskLaterAsynchronously(plugin, () -> {
            reconnectScheduled.set(false);
            connect();
        }, reconnectDelayTicks);
    }

    private static String escape(String value) {
        return value.replace("\\", "\\\\").replace("\"", "\\\"");
    }
}
