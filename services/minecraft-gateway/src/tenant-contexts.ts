import path from "node:path";
import { OpenAiArchitectService, type ArchitectService } from "./architect.js";
import { OpenAiKeyStore } from "./openai-key-store.js";
import { ControlCenterStore } from "./store.js";
import type { TenantSummary } from "./tenant-registry.js";

export interface TenantContext {
  serverId: string;
  hostedTenant: boolean;
  store: ControlCenterStore;
  architect: ArchitectService;
}

export class TenantContexts {
  private readonly contexts = new Map<string, TenantContext>();

  constructor(defaultStore: ControlCenterStore, defaultArchitect: ArchitectService) {
    this.contexts.set("server_main", {
      serverId: "server_main",
      hostedTenant: false,
      store: defaultStore,
      architect: defaultArchitect,
    });
  }

  getDefault() {
    return this.contexts.get("server_main")!;
  }

  getExisting(serverId: string) {
    return this.contexts.get(serverId) ?? null;
  }

  getOrCreate(tenant: TenantSummary): TenantContext {
    const existing = this.contexts.get(tenant.serverId);
    if (existing) {
      existing.store.setServerName(tenant.displayName);
      return existing;
    }
    const stateDirectory = process.env.TENANT_STATE_DIRECTORY?.trim() || path.resolve("data", "servers");
    const keyDirectory = process.env.TENANT_KEY_DIRECTORY?.trim() || path.resolve("data", "keys");
    const statePath = path.join(stateDirectory, `${tenant.serverId}.json`);
    const keyPath = path.join(keyDirectory, `${tenant.serverId}.json`);
    const store = new ControlCenterStore(statePath, { serverId: tenant.serverId, name: tenant.displayName });
    const keyStore = new OpenAiKeyStore(keyPath, process.env.OPENAI_KEY_ENCRYPTION_SECRET?.trim(), false);
    const context: TenantContext = {
      serverId: tenant.serverId,
      hostedTenant: true,
      store,
      architect: new OpenAiArchitectService(keyStore),
    };
    this.contexts.set(tenant.serverId, context);
    return context;
  }

  values() {
    return [...this.contexts.values()];
  }

  async close() {
    await Promise.all(this.values().map((context) => context.store.close()));
  }
}
