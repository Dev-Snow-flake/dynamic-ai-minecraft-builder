package dev.dynamicai.bridge;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.PosixFilePermission;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.EnumSet;
import java.util.UUID;

final class EnrollmentCredentials {
    private static final SecureRandom RANDOM = new SecureRandom();

    final String installationId;
    final String bridgeToken;
    final String serverId;

    EnrollmentCredentials(String installationId, String bridgeToken, String serverId) {
        this.installationId = installationId;
        this.bridgeToken = bridgeToken;
        this.serverId = serverId;
    }

    static EnrollmentCredentials loadOrCreate(Path target) throws IOException {
        if (Files.exists(target)) {
            JsonObject json = JsonParser.parseString(Files.readString(target, StandardCharsets.UTF_8)).getAsJsonObject();
            String installationId = required(json, "installationId");
            String bridgeToken = required(json, "bridgeToken");
            String serverId = json.has("serverId") ? json.get("serverId").getAsString() : "";
            if (bridgeToken.length() < 43) throw new IOException("stored bridge token is invalid");
            return new EnrollmentCredentials(installationId, bridgeToken, serverId);
        }
        byte[] token = new byte[32];
        RANDOM.nextBytes(token);
        EnrollmentCredentials created = new EnrollmentCredentials(
            UUID.randomUUID().toString(),
            Base64.getUrlEncoder().withoutPadding().encodeToString(token),
            ""
        );
        created.save(target);
        return created;
    }

    EnrollmentCredentials withServerId(String value) {
        return new EnrollmentCredentials(installationId, bridgeToken, value);
    }

    void save(Path target) throws IOException {
        Files.createDirectories(target.getParent());
        JsonObject json = new JsonObject();
        json.addProperty("version", 1);
        json.addProperty("installationId", installationId);
        json.addProperty("bridgeToken", bridgeToken);
        json.addProperty("serverId", serverId);
        Path temporary = target.resolveSibling(target.getFileName() + ".tmp");
        Files.writeString(temporary, json + System.lineSeparator(), StandardCharsets.UTF_8);
        try {
            Files.setPosixFilePermissions(temporary, EnumSet.of(PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_WRITE));
        } catch (UnsupportedOperationException ignored) {
            // Windows and a few custom filesystems do not expose POSIX permissions.
        }
        try {
            Files.move(temporary, target, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        } catch (AtomicMoveNotSupportedException ignored) {
            Files.move(temporary, target, StandardCopyOption.REPLACE_EXISTING);
        }
    }

    private static String required(JsonObject json, String name) throws IOException {
        if (!json.has(name) || !json.get(name).isJsonPrimitive()) throw new IOException("missing " + name);
        String value = json.get(name).getAsString();
        if (value.isBlank()) throw new IOException("empty " + name);
        return value;
    }
}
