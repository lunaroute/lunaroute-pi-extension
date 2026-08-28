import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { RefreshModelsContext } from "@earendil-works/pi-ai";
import {
  mapCatalogEntry,
  resolveCredentialKey,
  resolveRoutingUrl,
  toStoredModel,
  type GatewayModelObject,
} from "./lunaroute.js";

export type DiscoveryDeps = {
  fetch?: typeof fetch;
  /** Called after a successful network fetch with the mapped models, so the
   * caller can react (e.g. auto-select a model when none is chosen). */
  onCatalogRefreshed?: (models: ProviderModelConfig[]) => void;
};

/** Restored catalog from a prior session, as ProviderModelConfig[]. Stored
 * entries are Model<Api> objects (a structural superset); returning them lets
 * provider-composer's applyExtension re-fill api/baseUrl/provider, making the
 * registry non-empty before any network call. */
function restore(stored: RefreshModelsContext["stored"]): ProviderModelConfig[] {
  return stored ? [...stored.models] : [];
}

export function createRefreshModels(
  env: NodeJS.ProcessEnv,
  deps: DiscoveryDeps = {},
): (context: RefreshModelsContext) => Promise<ProviderModelConfig[]> {
  const doFetch = deps.fetch ?? fetch;
  const onCatalogRefreshed = deps.onCatalogRefreshed;
  return async (context) => {
    const baseUrl = resolveRoutingUrl(env);
    // Phase 1 (offline / restore): surface the persisted catalog so getModels()
    // is non-empty at startup — Pi's last-model restore and Desktop/RPC model
    // listings read getModels() synchronously, before any network refresh.
    if (!context.allowNetwork) return restore(context.stored);

    const key = resolveCredentialKey(context.credential);
    if (!key) return restore(context.stored);

    try {
      const res = await doFetch(`${baseUrl}/models`, {
        signal: context.signal,
        headers: { Authorization: `Bearer ${key}` },
      });
      if (!res.ok) return restore(context.stored);
      const body = (await res.json()) as { data?: GatewayModelObject[] };
      const entries = body.data ?? [];

      const models: ProviderModelConfig[] = [];
      for (const entry of entries) {
        const result = mapCatalogEntry(entry);
        if (result.ok) models.push(result.model);
      }
      // Persist for next startup. The returned list is applied to the in-memory
      // registry by the provider-composer wrapper; publish({persist}) writes the
      // catalog to Pi's ModelsStore so context.stored is populated next launch.
      // A store-write failure must not discard the fresh catalog — the in-memory
      // list still updates via the wrapper, and the next refresh retries persist.
      await context.publish({
        persist: { models: models.map((m) => toStoredModel(m, baseUrl)), checkedAt: Date.now() },
      }).catch(() => {});
      onCatalogRefreshed?.(models);
      return models;
    } catch {
      return restore(context.stored);
    }
  };
}
