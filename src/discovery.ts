import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { RefreshModelsContext } from "@earendil-works/pi-ai";
import {
  mapCatalogEntry,
  resolveCredentialKey,
  resolveRoutingUrl,
  type GatewayModelObject,
} from "./lunaroute.js";

export type DiscoveryDeps = {
  fetch?: typeof fetch;
};

export function createRefreshModels(
  env: NodeJS.ProcessEnv,
  deps: DiscoveryDeps = {},
): (context: RefreshModelsContext) => Promise<ProviderModelConfig[]> {
  const doFetch = deps.fetch ?? fetch;
  return async (context) => {
    if (!context.allowNetwork) return [];
    const key = resolveCredentialKey(context.credential);
    if (!key) return [];

    const baseUrl = resolveRoutingUrl(env);
    try {
      const res = await doFetch(`${baseUrl}/models`, {
        signal: context.signal,
        headers: { Authorization: `Bearer ${key}` },
      });
      if (!res.ok) return [];
      const body = (await res.json()) as { data?: GatewayModelObject[] };
      const entries = body.data ?? [];

      const models: ProviderModelConfig[] = [];
      for (const entry of entries) {
        const result = mapCatalogEntry(entry);
        if (result.ok) models.push(result.model);
      }
      return models;
    } catch {
      return [];
    }
  };
}
