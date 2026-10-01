import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { Api, Model, RefreshModelsContext } from "@earendil-works/pi-ai";
import {
  isClassifierConfig,
  mapCatalogEntry,
  mapClassifierEntry,
  resolveApi,
  resolveCredentialKey,
  resolveRoutingUrl,
  selectStoredModels,
  toStoredClassifier,
  toStoredModel,
  type GatewayModelObject,
  type WireApi,
} from "./lunaroute.js";

export type DiscoveryDeps = {
  fetch?: typeof fetch;
  /** Host supports classifier models (pi >= 0.99.0). When false, System One
   * entries stay rejected and stored classifiers are dropped. */
  classifiers?: boolean;
  /** Called after a successful network fetch with the mapped models, so the
   * caller can react (e.g. auto-select a model when none is chosen). */
  onCatalogRefreshed?: (models: ProviderModelConfig[]) => void;
};

/** Restored catalog from a prior session, as definitions. Stored chat entries
 * are Model<Api> objects (a structural superset); the resolved wire format is
 * stamped over the stored api. Stored classifier entries keep their api (the
 * classifier api) but get the resolved routing URL stamped over any stored
 * baseUrl, so a persisted definition cannot outlive a LUNAROUTE_ROUTING_URL
 * change. */
function restore(
  stored: RefreshModelsContext["stored"],
  api: WireApi,
  classifiers: boolean,
  baseUrl: string,
): ProviderModelConfig[] {
  return stored
    ? (selectStoredModels(stored.models, api, classifiers, baseUrl) as unknown as ProviderModelConfig[])
    : [];
}

export function createRefreshModels(
  env: NodeJS.ProcessEnv,
  deps: DiscoveryDeps = {},
): (context: RefreshModelsContext) => Promise<ProviderModelConfig[]> {
  const doFetch = deps.fetch ?? fetch;
  const onCatalogRefreshed = deps.onCatalogRefreshed;
  const classifiers = deps.classifiers === true;
  return async (context) => {
    const baseUrl = resolveRoutingUrl(env);
    const api = resolveApi(env);
    // Phase 1 (offline / restore): surface the persisted catalog so getModels()
    // is non-empty at startup — Pi's last-model restore and Desktop/RPC model
    // listings read getModels() synchronously, before any network refresh.
    if (!context.allowNetwork) return restore(context.stored, api, classifiers, baseUrl);

    const key = resolveCredentialKey(context.credential);
    if (!key) return restore(context.stored, api, classifiers, baseUrl);

    let models: ProviderModelConfig[];
    try {
      const res = await doFetch(`${baseUrl}/models`, {
        signal: context.signal,
        headers: { Authorization: `Bearer ${key}` },
      });
      if (!res.ok) {
        models = restore(context.stored, api, classifiers, baseUrl);
      } else {
        const body = (await res.json()) as { data?: GatewayModelObject[] };
        const entries = body.data ?? [];

        const fetched: ProviderModelConfig[] = [];
        for (const entry of entries) {
          if (classifiers) {
            const classifier = mapClassifierEntry(entry);
            if (classifier) {
              fetched.push(classifier as unknown as ProviderModelConfig);
              continue;
            }
          }
          const result = mapCatalogEntry(entry);
          if (result.ok) fetched.push(result.model);
        }
        // Persist for next startup. The returned list is applied to the in-memory
        // registry by the provider-composer wrapper; publish({persist}) writes the
        // catalog to Pi's ModelsStore so context.stored is populated next launch.
        // A store-write failure must not discard the fresh catalog — the in-memory
        // list still updates via the wrapper, and the next refresh retries persist.
        await context.publish({
          persist: {
            models: fetched.map((m) =>
              isClassifierConfig(m) ? toStoredClassifier(m, baseUrl) : toStoredModel(m, baseUrl, api),
            ) as unknown as Model<Api>[],
            checkedAt: Date.now(),
          },
        }).catch(() => {});
        models = fetched;
      }
    } catch {
      models = restore(context.stored, api, classifiers, baseUrl);
    }
    // Notify exactly once per authenticated network attempt, with the list we
    // return: fresh on success, the persisted catalog when the attempt failed
    // (network error or non-2xx). Deliberately NOT fired on the offline /
    // unauthenticated paths above: pi's registerProvider seeds the registry
    // with an offline refresh at extension-load time, before session_start
    // reports the session's model — auto-picking from that window would
    // overwrite a user's saved default (kata 9v71). Invoked outside the
    // try/catch and guarded so a throwing callback neither double-fires (a
    // throw inside the old try would have rerouted to the catch path and
    // re-notified with the stale catalog) nor breaks the refresh it rides on.
    try {
      onCatalogRefreshed?.(models);
    } catch {
      // The auto-pick side channel must never break the refresh.
    }
    return models;
  };
}
