package dev.dynamicai.bridge;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.bukkit.plugin.java.JavaPlugin;

import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Duration;
import java.util.Set;
import java.util.regex.Pattern;

public final class DynamicAiBridgePlugin extends JavaPlugin {
    private static final Pattern SERVER_ID = Pattern.compile("[a-zA-Z0-9_-]{3,64}");
    private static final Set<String> LOOPBACK_HOSTS = Set.of("127.0.0.1", "localhost", "::1");
    private BridgeClient bridgeClient;
    private BuildExecutor buildExecutor;
    private HttpClient enrollmentHttpClient;
    private URI gatewayUri;
    private long reconnectDelayTicks;
    private volatile boolean shuttingDown;

    @Override
    public void onEnable() {
        saveDefaultConfig();
        buildExecutor = new BuildExecutor(this);
        buildExecutor.recover();

        String gatewayUriValue = getConfig().getString("gateway.uri", "wss://map.work-plus.kr/bridge");
        String serverId = getConfig().getString("server-id", "server_main");
        reconnectDelayTicks = Math.max(20L, getConfig().getLong("gateway.reconnect-delay-ticks", 100L));

        try {
            gatewayUri = URI.create(gatewayUriValue);
        } catch (IllegalArgumentException error) {
            getLogger().severe("gateway.uri is invalid. The plugin will stay disabled.");
            return;
        }
        boolean secure = "wss".equalsIgnoreCase(gatewayUri.getScheme());
        boolean local = "ws".equalsIgnoreCase(gatewayUri.getScheme()) && LOOPBACK_HOSTS.contains(gatewayUri.getHost());
        if (!secure && !local) {
            getLogger().severe("Remote Gateway connections must use wss://. Plain ws:// is allowed only for loopback.");
            return;
        }

        String secret = System.getenv("DYNAMIC_AI_BRIDGE_SECRET");
        if (secret == null || secret.isBlank()) secret = getConfig().getString("gateway.shared-secret", "");
        if (secret.length() >= 32) {
            if (!SERVER_ID.matcher(serverId).matches()) {
                getLogger().severe("server-id must match [a-zA-Z0-9_-]{3,64}. The plugin will stay disabled.");
                return;
            }
            connectBridge(secret, serverId);
            return;
        }
        if (!getConfig().getBoolean("gateway.auto-enroll", true)) {
            getLogger().severe("No bridge secret is configured and automatic enrollment is disabled.");
            return;
        }
        beginAutomaticEnrollment();
    }

    @Override
    public void onDisable() {
        shuttingDown = true;
        if (buildExecutor != null) {
            buildExecutor.shutdown();
        }
        if (bridgeClient != null) {
            bridgeClient.close();
        }
        if (enrollmentHttpClient != null) enrollmentHttpClient.close();
    }

    private void beginAutomaticEnrollment() {
        URI enrollmentUri;
        try {
            enrollmentUri = URI.create(getConfig().getString("gateway.enrollment-uri", "https://map.work-plus.kr/api/v1/public/servers/enroll"));
        } catch (IllegalArgumentException error) {
            getLogger().severe("gateway.enrollment-uri is invalid. The plugin will stay disabled.");
            return;
        }
        boolean secure = "https".equalsIgnoreCase(enrollmentUri.getScheme());
        boolean local = "http".equalsIgnoreCase(enrollmentUri.getScheme()) && LOOPBACK_HOSTS.contains(enrollmentUri.getHost());
        if (!secure && !local) {
            getLogger().severe("Remote enrollment must use https://. Plain http:// is allowed only for loopback.");
            return;
        }
        Path credentialPath = getDataFolder().toPath().resolve("credentials.json");
        EnrollmentCredentials credentials;
        try {
            credentials = EnrollmentCredentials.loadOrCreate(credentialPath);
        } catch (Exception error) {
            getLogger().severe("Unable to load secure enrollment credentials: " + error.getMessage());
            return;
        }
        enrollmentHttpClient = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(8)).build();
        enroll(enrollmentUri, credentialPath, credentials);
    }

    private void enroll(URI enrollmentUri, Path credentialPath, EnrollmentCredentials credentials) {
        if (shuttingDown) return;
        JsonObject body = new JsonObject();
        body.addProperty("installationId", credentials.installationId);
        body.addProperty("bridgeToken", credentials.bridgeToken);
        body.addProperty("displayName", getConfig().getString("display-name", getServer().getName()));
        HttpRequest request = HttpRequest.newBuilder(enrollmentUri)
            .timeout(Duration.ofSeconds(15))
            .header("Content-Type", "application/json")
            .POST(HttpRequest.BodyPublishers.ofString(body.toString(), StandardCharsets.UTF_8))
            .build();
        enrollmentHttpClient.sendAsync(request, HttpResponse.BodyHandlers.ofByteArray()).whenComplete((response, error) -> {
            if (shuttingDown) return;
            if (error != null || response == null || response.body().length > 65_536) {
                getLogger().warning("Automatic enrollment failed; the Gateway may be temporarily unavailable.");
                if (!credentials.serverId.isBlank()) connectBridge(credentials.bridgeToken, credentials.serverId);
                else scheduleEnrollmentRetry(enrollmentUri, credentialPath, credentials);
                return;
            }
            if (response.statusCode() == 201) {
                try {
                    JsonObject data = JsonParser.parseString(new String(response.body(), StandardCharsets.UTF_8))
                        .getAsJsonObject().getAsJsonObject("data");
                    String enrolledServerId = data.get("serverId").getAsString();
                    if (!SERVER_ID.matcher(enrolledServerId).matches()) throw new IllegalStateException("invalid server ID");
                    EnrollmentCredentials enrolled = credentials.withServerId(enrolledServerId);
                    enrolled.save(credentialPath);
                    getLogger().info("Dynamic AI server ID: " + enrolledServerId);
                    getLogger().info("Claim code: " + data.get("claimCode").getAsString());
                    getLogger().info("Open " + data.get("claimUrl").getAsString() + " to finish setup. The code expires at " + data.get("claimExpiresAt").getAsString());
                    connectBridge(enrolled.bridgeToken, enrolled.serverId);
                    return;
                } catch (Exception parseError) {
                    getLogger().warning("Gateway returned an invalid enrollment response: " + parseError.getMessage());
                }
            } else {
                getLogger().info("Enrollment returned HTTP " + response.statusCode() + ". Existing credentials will be used when available.");
            }
            if (!credentials.serverId.isBlank()) connectBridge(credentials.bridgeToken, credentials.serverId);
            else scheduleEnrollmentRetry(enrollmentUri, credentialPath, credentials);
        });
    }

    private void scheduleEnrollmentRetry(URI enrollmentUri, Path credentialPath, EnrollmentCredentials credentials) {
        if (shuttingDown) return;
        getServer().getScheduler().runTaskLaterAsynchronously(this, () -> enroll(enrollmentUri, credentialPath, credentials), reconnectDelayTicks);
    }

    private synchronized void connectBridge(String secret, String serverId) {
        if (shuttingDown || bridgeClient != null) return;
        bridgeClient = new BridgeClient(this, gatewayUri, secret, serverId, reconnectDelayTicks);
        bridgeClient.connect();
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
