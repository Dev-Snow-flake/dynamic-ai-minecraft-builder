package dev.dynamicai.bridge;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.bukkit.Bukkit;
import org.bukkit.Location;
import org.bukkit.World;
import org.bukkit.block.Block;
import org.bukkit.block.data.BlockData;
import org.bukkit.entity.Player;
import org.bukkit.scheduler.BukkitTask;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.PosixFilePermission;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

final class BuildExecutor {
    private static final Gson GSON = new Gson();
    private static final Set<String> DEFAULT_ALLOWED_BLOCKS = Set.of(
        "minecraft:spruce_planks",
        "minecraft:stone_bricks",
        "minecraft:glass",
        "minecraft:oxidized_copper"
    );

    private final DynamicAiBridgePlugin plugin;
    private final Path buildDirectory;
    private BuildRecord active;
    private BukkitTask scheduledTask;
    private volatile boolean pauseRequested;
    private Mode mode = Mode.IDLE;

    BuildExecutor(DynamicAiBridgePlugin plugin) {
        this.plugin = plugin;
        this.buildDirectory = plugin.getDataFolder().toPath().resolve("build-diffs");
    }

    void recover() {
        try {
            if (!Files.isDirectory(buildDirectory)) return;
            Path newest = null;
            long newestModified = Long.MIN_VALUE;
            try (var entries = Files.list(buildDirectory)) {
                for (Path candidate : entries.filter(path -> path.getFileName().toString().endsWith(".json")).toList()) {
                    long modified = Files.getLastModifiedTime(candidate).toMillis();
                    if (modified > newestModified) {
                        newest = candidate;
                        newestModified = modified;
                    }
                }
            }
            if (newest == null) return;
            BuildRecord record = GSON.fromJson(Files.readString(newest, StandardCharsets.UTF_8), BuildRecord.class);
            if (record == null || record.buildId == null || record.diffs == null || "ROLLED_BACK".equals(record.state)) return;
            World world = plugin.getServer().getWorld(record.world);
            if (world == null) throw new IllegalStateException("Recovery world is not loaded: " + record.world);
            boolean allOriginal = true;
            boolean allDesired = true;
            int appliedPrefix = 0;
            boolean prefixOpen = true;
            for (DiffEntry diff : record.diffs) {
                String current = world.getBlockAt(diff.x, diff.y, diff.z).getBlockData().getAsString();
                allOriginal &= current.equals(diff.original);
                allDesired &= current.equals(diff.desired);
                if (prefixOpen && current.equals(diff.desired)) {
                    appliedPrefix += 1;
                } else {
                    prefixOpen = false;
                }
            }
            if ("ROLLED_BACK".equals(record.state) || (allOriginal && !allDesired)) return;
            record.applied = allDesired ? record.diffs.size() : appliedPrefix;
            active = record;
            mode = record.applied == record.diffs.size() ? Mode.COMPLETED : Mode.PAUSED;
            record.state = mode.name();
            plugin.getLogger().warning("Recovered build diff " + record.buildId + " in " + mode + " state. Resume or roll back from the control center.");
        } catch (Exception error) {
            plugin.getLogger().severe("Unable to recover build diff metadata: " + error.getMessage());
        }
    }

    void handle(String method, JsonObject payload, String correlationId) {
        switch (method) {
            case "build.prepare" -> prepare(payload, correlationId);
            case "build.start" -> start(payload, correlationId);
            case "build.pause" -> pause(payload, correlationId);
            case "build.resume" -> resume(payload, correlationId);
            case "build.rollback" -> rollback(payload, correlationId);
            default -> plugin.respond(correlationId, false, "METHOD_NOT_ALLOWED", "지원하지 않는 월드 쓰기 명령입니다.", new JsonObject());
        }
    }

    void onBridgeDisconnected() {
        if (mode == Mode.RUNNING) pauseRequested = true;
    }

    JsonObject status() {
        return active == null ? null : statusData(active);
    }

    void shutdown() {
        cancelScheduledTask();
        if (mode == Mode.RUNNING) {
            mode = Mode.PAUSED;
            if (active != null) active.state = "PAUSED";
        }
    }

    private void prepare(JsonObject payload, String correlationId) {
        try {
            String requestedBuildId = requiredString(payload, "buildId");
            int requestedPlanVersion = payload.get("planVersion").getAsInt();
            if (active != null && active.buildId.equals(requestedBuildId) && active.planVersion == requestedPlanVersion && mode != Mode.IDLE) {
                plugin.respond(correlationId, true, "BUILD_ALREADY_ACCEPTED", "동일한 청사진 명령의 기존 실행 상태를 반환합니다.", statusData(active));
                return;
            }
            if (mode != Mode.IDLE && mode != Mode.ROLLED_BACK) {
                plugin.respond(correlationId, false, "BUILD_ALREADY_ACTIVE", "다른 작업의 diff가 남아 있습니다. 먼저 완료하거나 롤백해 주세요.", new JsonObject());
                return;
            }
            if (!plugin.getConfig().getBoolean("policy.allow-world-writes", false)) {
                plugin.respond(correlationId, false, "WORLD_WRITES_DISABLED", "플러그인 설정에서 월드 쓰기가 비활성화되어 있습니다.", new JsonObject());
                return;
            }
            BuildRecord record = parseAndValidate(payload);
            active = record;
            mode = Mode.PREPARING;
            pauseRequested = false;
            plugin.getServer().getScheduler().runTaskAsynchronously(plugin, () -> {
                try {
                    record.state = "PAUSED";
                    persist(record);
                    plugin.respond(correlationId, true, "BUILD_PREPARED", "원본 diff를 저장했고 시작 명령을 기다립니다.", statusData(record));
                    plugin.getServer().getScheduler().runTask(plugin, () -> {
                        if (active != record || mode != Mode.PREPARING) return;
                        mode = Mode.PAUSED;
                    });
                } catch (Exception error) {
                    active = null;
                    mode = Mode.IDLE;
                    plugin.respond(correlationId, false, "DIFF_PERSIST_FAILED", "원본 diff를 안전하게 저장하지 못했습니다.", new JsonObject());
                    plugin.getLogger().severe("Unable to persist build diff: " + error.getMessage());
                }
            });
        } catch (PolicyException error) {
            plugin.respond(correlationId, false, error.code, error.getMessage(), new JsonObject());
        } catch (Exception error) {
            plugin.respond(correlationId, false, "INVALID_BUILD_PLAN", "청사진 명령 형식이 올바르지 않습니다.", new JsonObject());
        }
    }

    private void start(JsonObject payload, String correlationId) {
        if (matchesActive(payload) && mode == Mode.RUNNING) {
            plugin.respond(correlationId, true, "BUILD_ALREADY_RUNNING", "작업이 이미 실행 중입니다.", statusData(active));
            return;
        }
        if (!matchesActive(payload) || mode != Mode.PAUSED) {
            plugin.respond(correlationId, false, "BUILD_NOT_PREPARED", "준비가 완료된 청사진만 시작할 수 있습니다.", new JsonObject());
            return;
        }
        resumePrepared(correlationId, "BUILD_STARTED", "시공을 시작합니다.");
    }

    private BuildRecord parseAndValidate(JsonObject payload) {
        String buildId = requiredString(payload, "buildId");
        if (!buildId.matches("[a-zA-Z0-9_-]{3,96}")) throw new PolicyException("INVALID_BUILD_ID", "작업 ID 형식이 올바르지 않습니다.");
        int planVersion = payload.get("planVersion").getAsInt();
        String worldName = requiredString(payload, "world");
        World world = plugin.getServer().getWorld(worldName);
        if (world == null || !plugin.getConfig().getStringList("policy.allowed-worlds").contains(worldName)) {
            throw new PolicyException("WORLD_NOT_ALLOWED", "허용되지 않았거나 로드되지 않은 월드입니다.");
        }
        checkPerformance();

        JsonArray blocks = payload.getAsJsonArray("blocks");
        int maximumTotal = Math.max(1, plugin.getConfig().getInt("policy.maximum-total-blocks", 12_000));
        if (blocks == null || blocks.isEmpty() || blocks.size() > maximumTotal) {
            throw new PolicyException("BUILD_SIZE_NOT_ALLOWED", "청사진 블록 수가 허용 범위를 벗어났습니다.");
        }

        Set<String> allowedBlocks = new HashSet<>(plugin.getConfig().getStringList("policy.allowed-blocks"));
        if (allowedBlocks.isEmpty()) allowedBlocks.addAll(DEFAULT_ALLOWED_BLOCKS);
        Set<String> coordinates = new HashSet<>();
        List<DiffEntry> diffs = new ArrayList<>(blocks.size());
        int minX = Integer.MAX_VALUE;
        int minY = Integer.MAX_VALUE;
        int minZ = Integer.MAX_VALUE;
        int maxX = Integer.MIN_VALUE;
        int maxY = Integer.MIN_VALUE;
        int maxZ = Integer.MIN_VALUE;

        for (var element : blocks) {
            JsonObject item = element.getAsJsonObject();
            int x = item.get("x").getAsInt();
            int y = item.get("y").getAsInt();
            int z = item.get("z").getAsInt();
            String blockState = requiredString(item, "block").toLowerCase(Locale.ROOT);
            if (y < world.getMinHeight() || y >= world.getMaxHeight()) throw new PolicyException("BUILD_HEIGHT_NOT_ALLOWED", "월드 높이 범위를 벗어난 블록이 있습니다.");
            if (!allowedBlocks.contains(blockState)) throw new PolicyException("PROHIBITED_BLOCK", "허용되지 않은 블록이 청사진에 포함되어 있습니다.");
            if (!insideAllowedRegion(worldName, x, y, z)) throw new PolicyException("REGION_NOT_ALLOWED", "청사진이 플러그인 허용 영역을 벗어났습니다.");
            if (!world.isChunkLoaded(x >> 4, z >> 4)) throw new PolicyException("CHUNK_NOT_LOADED", "시공 영역의 모든 청크를 먼저 로드해 주세요.");
            if (!coordinates.add(x + ":" + y + ":" + z)) throw new PolicyException("DUPLICATE_BLOCK", "청사진에 중복 좌표가 있습니다.");

            BlockData desired;
            try {
                desired = Bukkit.createBlockData(blockState);
            } catch (IllegalArgumentException error) {
                throw new PolicyException("INVALID_BLOCK_STATE", "유효하지 않은 Minecraft 블록 상태가 있습니다.");
            }
            Block current = world.getBlockAt(x, y, z);
            diffs.add(new DiffEntry(x, y, z, current.getBlockData().getAsString(), desired.getAsString()));
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            minZ = Math.min(minZ, z);
            maxX = Math.max(maxX, x);
            maxY = Math.max(maxY, y);
            maxZ = Math.max(maxZ, z);
        }
        checkPlayers(world, minX, minY, minZ, maxX, maxY, maxZ);
        return new BuildRecord(buildId, planVersion, worldName, "PREPARING", 0, 0, diffs);
    }

    private void pause(JsonObject payload, String correlationId) {
        if (matchesActive(payload) && mode == Mode.PAUSED) {
            plugin.respond(correlationId, true, "BUILD_ALREADY_PAUSED", "작업이 이미 일시정지되어 있습니다.", statusData(active));
            return;
        }
        if (!matchesActive(payload) || mode != Mode.RUNNING) {
            plugin.respond(correlationId, false, "INVALID_STATE", "현재 실행 중인 작업이 아닙니다.", new JsonObject());
            return;
        }
        pauseRequested = true;
        plugin.respond(correlationId, true, "PAUSE_REQUESTED", "현재 배치가 끝난 뒤 정지합니다.", statusData(active));
    }

    private void resume(JsonObject payload, String correlationId) {
        if (matchesActive(payload) && mode == Mode.RUNNING) {
            plugin.respond(correlationId, true, "BUILD_ALREADY_RUNNING", "작업이 이미 실행 중입니다.", statusData(active));
            return;
        }
        if (!matchesActive(payload) || mode != Mode.PAUSED) {
            plugin.respond(correlationId, false, "INVALID_STATE", "일시정지된 작업만 재개할 수 있습니다.", new JsonObject());
            return;
        }
        resumePrepared(correlationId, "BUILD_RESUMED", "시공을 재개합니다.");
    }

    private void resumePrepared(String correlationId, String code, String message) {
        try {
            checkPerformance();
            World world = requiredWorld(active.world);
            Bounds bounds = bounds(active.diffs);
            ensureChunksLoaded(world, bounds);
            checkPlayers(world, bounds.minX, bounds.minY, bounds.minZ, bounds.maxX, bounds.maxY, bounds.maxZ);
            pauseRequested = false;
            mode = Mode.RUNNING;
            active.state = "RUNNING";
            plugin.respond(correlationId, true, code, message, statusData(active));
            scheduleBuildBatch(1L);
        } catch (PolicyException error) {
            plugin.respond(correlationId, false, error.code, error.getMessage(), new JsonObject());
        }
    }

    private void rollback(JsonObject payload, String correlationId) {
        if (matchesActive(payload) && (mode == Mode.ROLLING_BACK || mode == Mode.ROLLED_BACK)) {
            plugin.respond(correlationId, true, "ROLLBACK_ALREADY_ACCEPTED", "동일한 롤백의 기존 상태를 반환합니다.", statusData(active));
            return;
        }
        if (!matchesActive(payload) || !(mode == Mode.RUNNING || mode == Mode.PAUSED || mode == Mode.COMPLETED)) {
            plugin.respond(correlationId, false, "INVALID_STATE", "롤백할 수 있는 작업이 없습니다.", new JsonObject());
            return;
        }
        cancelScheduledTask();
        mode = Mode.ROLLING_BACK;
        active.state = "ROLLING_BACK";
        active.rollbackIndex = active.diffs.size() - 1;
        pauseRequested = false;
        plugin.respond(correlationId, true, "ROLLBACK_ACCEPTED", "원본 블록 상태를 역순으로 복구합니다.", statusData(active));
        scheduleRollbackBatch(1L);
    }

    private void runBuildBatch() {
        scheduledTask = null;
        if (mode != Mode.RUNNING || active == null) return;
        try {
            if (!plugin.isBridgeConnected() || pauseRequested) {
                pauseRequested = false;
                mode = Mode.PAUSED;
                active.state = "PAUSED";
                emit("build.paused", plugin.isBridgeConnected() ? "체크포인트에서 안전하게 정지했습니다." : "Gateway 연결이 끊겨 다음 블록 쓰기 전에 정지했습니다.");
                return;
            }
            checkPerformance();
            World world = requiredWorld(active.world);
            Bounds bounds = bounds(active.diffs);
            ensureChunksLoaded(world, bounds);
            checkPlayers(world, bounds.minX, bounds.minY, bounds.minZ, bounds.maxX, bounds.maxY, bounds.maxZ);

            int batchSize = Math.max(1, Math.min(250, plugin.getConfig().getInt("policy.maximum-batch-blocks", 250)));
            int end = Math.min(active.diffs.size(), active.applied + batchSize);
            for (int index = active.applied; index < end; index++) {
                DiffEntry diff = active.diffs.get(index);
                Block block = world.getBlockAt(diff.x, diff.y, diff.z);
                if (!block.getBlockData().getAsString().equals(diff.original)) {
                    throw new PolicyException("STALE_SNAPSHOT", "시공 전 월드 블록이 변경되어 안전 정지했습니다.");
                }
                block.setBlockData(Bukkit.createBlockData(diff.desired), false);
                active.applied = index + 1;
            }
            active.state = "RUNNING";
            emit("build.progress", "실제 월드에 승인된 블록을 배치했습니다.");

            if (active.applied >= active.diffs.size()) {
                validateCompletion(world);
                mode = Mode.COMPLETED;
                active.state = "COMPLETED";
                persistFinalState(active);
                emit("build.completed", "Paper 월드의 모든 대상 블록을 검증했습니다.");
                return;
            }
            scheduleBuildBatch(1L);
        } catch (PolicyException error) {
            mode = Mode.PAUSED;
            active.state = "PAUSED";
            emit("build.paused", error.getMessage());
        } catch (Exception error) {
            mode = Mode.PAUSED;
            active.state = "PAUSED";
            emit("build.failed", "Paper 블록 배치 중 오류가 발생해 안전 정지했습니다.");
            plugin.getLogger().severe("Build batch failed: " + error.getMessage());
        }
    }

    private void runRollbackBatch() {
        scheduledTask = null;
        if (mode != Mode.ROLLING_BACK || active == null) return;
        try {
            checkPerformance();
            World world = requiredWorld(active.world);
            Bounds bounds = bounds(active.diffs);
            ensureChunksLoaded(world, bounds);
            checkPlayers(world, bounds.minX, bounds.minY, bounds.minZ, bounds.maxX, bounds.maxY, bounds.maxZ);
            int batchSize = Math.max(1, Math.min(250, plugin.getConfig().getInt("policy.maximum-batch-blocks", 250)));
            int processed = 0;
            while (active.rollbackIndex >= 0 && processed < batchSize) {
                DiffEntry diff = active.diffs.get(active.rollbackIndex--);
                Block block = world.getBlockAt(diff.x, diff.y, diff.z);
                String current = block.getBlockData().getAsString();
                if (current.equals(diff.desired)) {
                    block.setBlockData(Bukkit.createBlockData(diff.original), false);
                } else if (!current.equals(diff.original)) {
                    active.conflicts += 1;
                }
                active.applied = Math.min(active.applied, Math.max(0, active.rollbackIndex + 1));
                processed += 1;
            }
            emit("build.rollback.progress", "원본 블록 상태를 복구하고 있습니다.");
            if (active.rollbackIndex < 0) {
                mode = Mode.ROLLED_BACK;
                active.state = "ROLLED_BACK";
                active.applied = 0;
                persistFinalState(active);
                emit("build.rollback.completed", active.conflicts == 0 ? "원본 블록 상태로 복구했습니다." : "외부 변경 충돌을 보존하고 나머지 블록을 복구했습니다.");
                return;
            }
            scheduleRollbackBatch(1L);
        } catch (PolicyException error) {
            emit("build.rollback.progress", error.getMessage() + " 조건이 회복되면 자동으로 롤백을 계속합니다.");
            scheduleRollbackBatch(20L);
        } catch (Exception error) {
            mode = Mode.PAUSED;
            active.state = "PAUSED";
            emit("build.failed", "롤백 중 오류가 발생해 운영자 확인이 필요합니다.");
            plugin.getLogger().severe("Rollback batch failed: " + error.getMessage());
        }
    }

    private void validateCompletion(World world) {
        for (DiffEntry diff : active.diffs) {
            if (!world.getBlockAt(diff.x, diff.y, diff.z).getBlockData().getAsString().equals(diff.desired)) {
                throw new PolicyException("VALIDATION_FAILED", "시공 결과가 청사진과 일치하지 않아 안전 정지했습니다.");
            }
        }
    }

    private void emit(String eventType, String message) {
        JsonObject payload = new JsonObject();
        payload.addProperty("eventType", eventType);
        payload.addProperty("buildId", active.buildId);
        payload.addProperty("appliedBlocks", active.applied);
        payload.addProperty("totalBlocks", active.diffs.size());
        payload.addProperty("checkpoint", "cp_" + String.format("%05d", active.applied));
        payload.addProperty("conflicts", active.conflicts);
        payload.addProperty("message", message);
        plugin.emitBridgeEvent(payload);
    }

    private void scheduleBuildBatch(long delay) {
        cancelScheduledTask();
        scheduledTask = plugin.getServer().getScheduler().runTaskLater(plugin, this::runBuildBatch, delay);
    }

    private void scheduleRollbackBatch(long delay) {
        cancelScheduledTask();
        scheduledTask = plugin.getServer().getScheduler().runTaskLater(plugin, this::runRollbackBatch, delay);
    }

    private void cancelScheduledTask() {
        if (scheduledTask != null) scheduledTask.cancel();
        scheduledTask = null;
    }

    private void checkPerformance() {
        double minimumTps = plugin.getConfig().getDouble("policy.minimum-tps", 18.0);
        double maximumMspt = plugin.getConfig().getDouble("policy.maximum-mspt", 40.0);
        if (plugin.getServer().getTPS()[0] < minimumTps) throw new PolicyException("TPS_TOO_LOW", "서버 TPS가 안전 임계값보다 낮습니다.");
        if (plugin.getServer().getAverageTickTime() > maximumMspt) throw new PolicyException("MSPT_TOO_HIGH", "서버 MSPT가 안전 임계값을 초과했습니다.");
    }

    private void checkPlayers(World world, int minX, int minY, int minZ, int maxX, int maxY, int maxZ) {
        int radius = Math.max(0, plugin.getConfig().getInt("policy.player-exclusion-radius", 24));
        for (Player player : world.getPlayers()) {
            Location location = player.getLocation();
            if (location.getX() >= minX - radius && location.getX() <= maxX + radius
                && location.getY() >= minY - radius && location.getY() <= maxY + radius
                && location.getZ() >= minZ - radius && location.getZ() <= maxZ + radius) {
                throw new PolicyException("PLAYER_NEARBY", "플레이어가 시공 안전거리 안에 있습니다.");
            }
        }
    }

    private void ensureChunksLoaded(World world, Bounds bounds) {
        for (int chunkX = bounds.minX >> 4; chunkX <= bounds.maxX >> 4; chunkX++) {
            for (int chunkZ = bounds.minZ >> 4; chunkZ <= bounds.maxZ >> 4; chunkZ++) {
                if (!world.isChunkLoaded(chunkX, chunkZ)) throw new PolicyException("CHUNK_NOT_LOADED", "시공 영역 청크가 언로드되어 안전 정지했습니다.");
            }
        }
    }

    private boolean insideAllowedRegion(String world, int x, int y, int z) {
        for (Map<?, ?> item : plugin.getConfig().getMapList("policy.allowed-regions")) {
            if (!world.equals(String.valueOf(item.get("world")))) continue;
            Map<?, ?> min = asMap(item.get("min"));
            Map<?, ?> max = asMap(item.get("max-exclusive"));
            if (min == null || max == null) continue;
            if (x >= number(min, "x") && y >= number(min, "y") && z >= number(min, "z")
                && x < number(max, "x") && y < number(max, "y") && z < number(max, "z")) return true;
        }
        return false;
    }

    private boolean matchesActive(JsonObject payload) {
        return active != null && payload != null && payload.has("buildId") && active.buildId.equals(payload.get("buildId").getAsString());
    }

    private World requiredWorld(String worldName) {
        World world = plugin.getServer().getWorld(worldName);
        if (world == null) throw new PolicyException("WORLD_NOT_LOADED", "작업 월드가 로드되어 있지 않습니다.");
        return world;
    }

    private Bounds bounds(List<DiffEntry> diffs) {
        int minX = Integer.MAX_VALUE, minY = Integer.MAX_VALUE, minZ = Integer.MAX_VALUE;
        int maxX = Integer.MIN_VALUE, maxY = Integer.MIN_VALUE, maxZ = Integer.MIN_VALUE;
        for (DiffEntry diff : diffs) {
            minX = Math.min(minX, diff.x); minY = Math.min(minY, diff.y); minZ = Math.min(minZ, diff.z);
            maxX = Math.max(maxX, diff.x); maxY = Math.max(maxY, diff.y); maxZ = Math.max(maxZ, diff.z);
        }
        return new Bounds(minX, minY, minZ, maxX, maxY, maxZ);
    }

    private JsonObject statusData(BuildRecord record) {
        JsonObject data = new JsonObject();
        data.addProperty("buildId", record.buildId);
        data.addProperty("state", record.state);
        data.addProperty("appliedBlocks", record.applied);
        data.addProperty("totalBlocks", record.diffs.size());
        return data;
    }

    private void persistFinalState(BuildRecord record) {
        plugin.getServer().getScheduler().runTaskAsynchronously(plugin, () -> {
            try {
                persist(record);
            } catch (IOException error) {
                plugin.getLogger().severe("Unable to persist final build state: " + error.getMessage());
            }
        });
    }

    private void persist(BuildRecord record) throws IOException {
        Files.createDirectories(buildDirectory);
        Path target = buildDirectory.resolve(record.buildId + ".json");
        Path temporary = buildDirectory.resolve(record.buildId + "." + UUID.randomUUID() + ".tmp");
        try {
            Files.writeString(temporary, GSON.toJson(record), StandardCharsets.UTF_8);
            try {
                Files.setPosixFilePermissions(temporary, Set.of(PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_WRITE));
            } catch (UnsupportedOperationException ignored) {
                // Windows development environments do not expose POSIX permissions.
            }
            try {
                Files.move(temporary, target, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
            } catch (AtomicMoveNotSupportedException ignored) {
                Files.move(temporary, target, StandardCopyOption.REPLACE_EXISTING);
            }
        } finally {
            Files.deleteIfExists(temporary);
        }
    }

    private static String requiredString(JsonObject object, String key) {
        if (object == null || !object.has(key) || !object.get(key).isJsonPrimitive()) throw new IllegalArgumentException(key);
        return object.get(key).getAsString();
    }

    @SuppressWarnings("unchecked")
    private static Map<?, ?> asMap(Object value) {
        return value instanceof Map<?, ?> map ? map : null;
    }

    private static int number(Map<?, ?> map, String key) {
        Object value = map.get(key);
        if (!(value instanceof Number number)) throw new PolicyException("INVALID_ALLOWED_REGION", "허용 영역 설정이 올바르지 않습니다.");
        return number.intValue();
    }

    private enum Mode { IDLE, PREPARING, RUNNING, PAUSED, COMPLETED, ROLLING_BACK, ROLLED_BACK }
    private record Bounds(int minX, int minY, int minZ, int maxX, int maxY, int maxZ) {}
    private record DiffEntry(int x, int y, int z, String original, String desired) {}

    private static final class BuildRecord {
        String buildId;
        int planVersion;
        String world;
        String state;
        int applied;
        int rollbackIndex;
        int conflicts;
        List<DiffEntry> diffs;

        BuildRecord(String buildId, int planVersion, String world, String state, int applied, int conflicts, List<DiffEntry> diffs) {
            this.buildId = buildId;
            this.planVersion = planVersion;
            this.world = world;
            this.state = state;
            this.applied = applied;
            this.rollbackIndex = -1;
            this.conflicts = conflicts;
            this.diffs = diffs;
        }
    }

    private static final class PolicyException extends RuntimeException {
        final String code;
        PolicyException(String code, String message) {
            super(message);
            this.code = code;
        }
    }
}
