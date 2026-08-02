package dev.dynamicai.bridge;

import com.google.gson.JsonObject;
import org.bukkit.plugin.java.JavaPlugin;

import java.net.URI;
import java.util.Set;
import java.util.regex.Pattern;

public final class DynamicAiBridgePlugin extends JavaPlugin {
    private static final Pattern SERVER_ID = Pattern.compile("[a-zA-Z0-9_-]{3,64}");
    private static final Set<String> LOOPBACK_HOSTS = Set.of("127.0.0.1", "localhost", "::1");
    private BridgeClient bridgeClient;
    private BuildExecutor buildExecutor;

    @Override
    public void onEnable() {
        saveDefaultConfig();
        buildExecutor = new BuildExecutor(this);
        buildExecutor.recover();

        String secret = System.getenv("DYNAMIC_AI_BRIDGE_SECRET");
        if (secret == null || secret.isBlank()) {
            secret = getConfig().getString("gateway.shared-secret", "");
        }
        if (secret.length() < 32) {
            getLogger().severe("Bridge secret must contain at least 32 characters. The plugin will stay disabled.");
            return;
        }

        String gatewayUri = getConfig().getString("gateway.uri", "ws://127.0.0.1:8787/bridge");
        String serverId = getConfig().getString("server-id", "server_main");
        long reconnectDelayTicks = getConfig().getLong("gateway.reconnect-delay-ticks", 100L);

        URI parsedGateway;
        try {
            parsedGateway = URI.create(gatewayUri);
        } catch (IllegalArgumentException error) {
            getLogger().severe("gateway.uri is invalid. The plugin will stay disabled.");
            return;
        }
        boolean secure = "wss".equalsIgnoreCase(parsedGateway.getScheme());
        boolean local = "ws".equalsIgnoreCase(parsedGateway.getScheme()) && LOOPBACK_HOSTS.contains(parsedGateway.getHost());
        if (!secure && !local) {
            getLogger().severe("Remote Gateway connections must use wss://. Plain ws:// is allowed only for loopback.");
            return;
        }
        if (!SERVER_ID.matcher(serverId).matches()) {
            getLogger().severe("server-id must match [a-zA-Z0-9_-]{3,64}. The plugin will stay disabled.");
            return;
        }

        bridgeClient = new BridgeClient(this, parsedGateway, secret, serverId, Math.max(20L, reconnectDelayTicks));
        bridgeClient.connect();
    }

    @Override
    public void onDisable() {
        if (buildExecutor != null) {
            buildExecutor.shutdown();
        }
        if (bridgeClient != null) {
            bridgeClient.close();
        }
    }

    void handleBuildCommand(String method, JsonObject payload, String correlationId) {
        if (buildExecutor == null) {
            respond(correlationId, false, "EXECUTOR_NOT_READY", "월드 실행기가 준비되지 않았습니다.", new JsonObject());
            return;
        }
        buildExecutor.handle(method, payload, correlationId);
    }

    void respond(String correlationId, boolean ok, String code, String message, JsonObject data) {
        if (bridgeClient != null) bridgeClient.sendResponse(correlationId, ok, code, message, data);
    }

    void emitBridgeEvent(JsonObject payload) {
        if (bridgeClient != null) bridgeClient.sendEvent(payload);
    }

    void onBridgeDisconnected() {
        if (buildExecutor != null) buildExecutor.onBridgeDisconnected();
    }

    boolean isBridgeConnected() {
        return bridgeClient != null && bridgeClient.isOpen();
    }

    JsonObject buildStatus() {
        return buildExecutor == null ? null : buildExecutor.status();
    }
}
