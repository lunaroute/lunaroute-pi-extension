import { beforeEach, describe, expect, test, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MCP_URL,
  LUNAROUTE_ENV_MCP_URL,
} from "../src/lunaroute.js";
import {
  LUNAROUTE_MCP_SERVER_NAME,
  MCP_INSTALL_HINT,
  MCP_RUNTIME_REGISTER_EVENT,
  MCP_RUNTIME_REGISTER_VERSION,
  _resetMcpState,
  buildMcpDefinition,
  disposeLunarouteMcp,
  maybeShowAdapterHint,
  registerLunarouteMcp,
  type McpRuntimeRegistrationRequest,
} from "../src/mcp.js";

type Bus = {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
};

function fakeEventBus(): Bus {
  const handlers = new Map<string, Set<(data: unknown) => void>>();
  return {
    emit(channel: string, data: unknown) {
      handlers.get(channel)?.forEach((h) => h(data));
    },
    on(channel: string, handler: (data: unknown) => void) {
      let set = handlers.get(channel);
      if (!set) {
        set = new Set();
        handlers.set(channel, set);
      }
      set.add(handler);
      return () => set!.delete(handler);
    },
  };
}

function fakePi(bus: Bus = fakeEventBus()) {
  return { events: bus } as unknown as ExtensionAPI;
}

/** Subscribe a fake pi-mcp-adapter listener that accepts registrations. */
function installFakeAdapter(bus: Bus) {
  const requests: McpRuntimeRegistrationRequest[] = [];
  const dispose = vi.fn().mockResolvedValue(undefined);
  bus.on(MCP_RUNTIME_REGISTER_EVENT, (raw) => {
    const req = raw as McpRuntimeRegistrationRequest;
    if (req.result !== undefined) return; // mirror adapter guard
    requests.push(req);
    req.result = { ok: true, registration: { dispose } };
  });
  return { requests, dispose };
}

const deps = { env: {}, version: "0.2.0", sessionId: "sess-1" };

beforeEach(() => {
  _resetMcpState();
});

describe("buildMcpDefinition", () => {
  test("uses the default MCP url and the api key + attribution headers, auth disabled", () => {
    const def = buildMcpDefinition("lr_key", deps);
    expect(def.url).toBe(DEFAULT_MCP_URL);
    expect(def.auth).toBe(false);
    expect(def.headers).toEqual({
      "LUNAROUTE-API-KEY": "lr_key",
      "lunaroute-agent": "pi/0.2.0",
      "x-lunaroute-session": "sess-1",
      "lunaroute-session-id": "sess-1",
    });
  });

  test("LUNAROUTE_MCP_URL overrides the default url", () => {
    const def = buildMcpDefinition("lr_key", {
      ...deps,
      env: { [LUNAROUTE_ENV_MCP_URL]: "http://localhost:9999/mcp" },
    });
    expect(def.url).toBe("http://localhost:9999/mcp");
  });
});

describe("registerLunarouteMcp", () => {
  test("emits the versioned event and stores the adapter handle when installed", () => {
    const bus = fakeEventBus();
    const pi = fakePi(bus);
    const adapter = installFakeAdapter(bus);

    const out = registerLunarouteMcp(pi, "lr_key", deps);

    expect(out.registered).toBe(true);
    expect(adapter.requests).toHaveLength(1);
    const req = adapter.requests[0];
    expect(req.version).toBe(MCP_RUNTIME_REGISTER_VERSION);
    expect(req.name).toBe(LUNAROUTE_MCP_SERVER_NAME);
    expect(req.definition.url).toBe(DEFAULT_MCP_URL);
    expect(req.definition.headers["LUNAROUTE-API-KEY"]).toBe("lr_key");
    expect(req.result?.ok).toBe(true);
  });

  test("returns registered:false and does not throw when the adapter is absent", () => {
    const pi = fakePi(); // no listener
    const out = registerLunarouteMcp(pi, "lr_key", deps);
    expect(out.registered).toBe(false);
  });

  test("returns the adapter's rejection as an error instead of throwing", () => {
    const bus = fakeEventBus();
    const pi = fakePi(bus);
    bus.on(MCP_RUNTIME_REGISTER_EVENT, (raw) => {
      const req = raw as McpRuntimeRegistrationRequest;
      req.result = { ok: false, error: new Error("duplicate name") };
    });
    const out = registerLunarouteMcp(pi, "lr_key", deps);
    expect(out.registered).toBe(false);
    expect(out.error?.message).toBe("duplicate name");
  });

  test("returns an error instead of throwing when the emit listener throws", () => {
    const bus = fakeEventBus();
    const pi = fakePi(bus);
    bus.on(MCP_RUNTIME_REGISTER_EVENT, () => {
      throw new Error("listener boom");
    });
    const out = registerLunarouteMcp(pi, "lr_key", deps);
    expect(out.registered).toBe(false);
    expect(out.error?.message).toBe("listener boom");
  });
});

describe("disposeLunarouteMcp", () => {
  test("disposes a stored registration and clears the handle", async () => {
    const bus = fakeEventBus();
    const pi = fakePi(bus);
    const adapter = installFakeAdapter(bus);
    registerLunarouteMcp(pi, "lr_key", deps);

    await disposeLunarouteMcp();

    expect(adapter.dispose).toHaveBeenCalledTimes(1);
  });

  test("swallows a dispose error instead of throwing", async () => {
    const bus = fakeEventBus();
    const pi = fakePi(bus);
    bus.on(MCP_RUNTIME_REGISTER_EVENT, (raw) => {
      const req = raw as McpRuntimeRegistrationRequest;
      req.result = { ok: true, registration: { dispose: vi.fn().mockRejectedValue(new Error("boom")) } };
    });
    registerLunarouteMcp(pi, "lr_key", deps);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(disposeLunarouteMcp()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("LunaRoute MCP dispose failed"));
    warn.mockRestore();
  });

  test("is a no-op when nothing is registered", async () => {
    await expect(disposeLunarouteMcp()).resolves.toBeUndefined();
  });
});

describe("maybeShowAdapterHint", () => {
  test("shows the install hint once, then is silent on the second call", () => {
    const notify = vi.fn();
    expect(maybeShowAdapterHint({ notify })).toBe(true);
    expect(notify).toHaveBeenCalledWith(MCP_INSTALL_HINT, "info");
    expect(maybeShowAdapterHint({ notify })).toBe(false);
    expect(notify).toHaveBeenCalledTimes(1);
  });
});
