import { initTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
	MCP_RUNTIME_REGISTER_EVENT,
	_resetMcpState,
	_setAdapterConfigLoader,
	registerLunarouteMcp,
	type McpRuntimeRegistrationRequest,
} from "../src/mcp.js";
import { DEFAULT_SETTINGS, type LunarouteSettings } from "../src/settings.js";
import {
	buildSettingsItems,
	createSettingChangeApplier,
	registerLunarouteSettingsCommand,
	type SettingsCommandDeps,
} from "../src/settings-ui.js";
import { _resetImageToolsState, registerImageTools } from "../src/image-tools.js";
import { _resetWebToolsState, registerWebTools, type FetchLike } from "../src/web-tools.js";

// keyHint/getSettingsListTheme read pi's global theme — initialize like the host does.
initTheme("dark");

const ENV = { PI_CODING_AGENT_DIR: "/tmp/bjy9-agent" } as NodeJS.ProcessEnv;

// ============================================================================
// Helpers
// ============================================================================

interface Bus {
	emit(channel: string, data: unknown): void;
	on(channel: string, handler: (data: unknown) => void): () => void;
}

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

function installFakeAdapter(bus: Bus) {
	const requests: McpRuntimeRegistrationRequest[] = [];
	const dispose = vi.fn().mockResolvedValue(undefined);
	bus.on(MCP_RUNTIME_REGISTER_EVENT, (raw) => {
		const req = raw as McpRuntimeRegistrationRequest;
		if (req.result !== undefined) return;
		requests.push(req);
		req.result = { ok: true, registration: { dispose } };
	});
	return { requests, dispose };
}

function fakePi(options: { toolNames?: string[]; activeTools?: string[] } = {}) {
	const registered: { name: string }[] = [];
	const toolNames = [...(options.toolNames ?? [])];
	let active = [...(options.activeTools ?? ["read", "bash"])];
	const bus = fakeEventBus();
	const pi = {
		registerTool: vi.fn((tool: { name: string }) => {
			registered.push(tool);
			toolNames.push(tool.name);
		}),
		registerCommand: vi.fn(),
		getAllTools: vi.fn(() => toolNames.map((name) => ({ name }))),
		getActiveTools: vi.fn(() => [...active]),
		setActiveTools: vi.fn((names: string[]) => {
			active = [...names];
		}),
		events: bus,
	};
	return { pi: pi as unknown as ExtensionAPI, registered, getActive: () => [...active], bus };
}

/** Scripted JSON-RPC server (subset of web-tools.test.ts's mcpFetch). */
function mcpFetch(routes: Record<string, () => unknown>): FetchLike {
	return async (_url: string, init?: RequestInit) => {
		const body = JSON.parse(String(init?.body)) as { id: number; method: string };
		return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: routes[body.method]?.() ?? {} }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	};
}

const WEB_TOOLS_FETCH = mcpFetch({
	initialize: () => ({}),
	"notifications/initialized": () => undefined,
	"tools/list": () => ({ tools: [{ name: "web_search" }] }),
});

function apierDeps(overrides: Partial<SettingsCommandDeps> = {}): SettingsCommandDeps {
	// Default write to a mock: applier tests assert file contents via the mock,
	// never against the real agent dir.
	return { env: ENV, version: "0.6.0-test", sessionId: "session-1", write: vi.fn() as never, ...overrides };
}

beforeEach(() => {
	vi.unstubAllEnvs();
	_resetImageToolsState();
	_resetWebToolsState();
	_resetMcpState();
	_setAdapterConfigLoader(async () => ({ mcpServers: {} }));
});

// ============================================================================
// buildSettingsItems (pure)
// ============================================================================

describe("buildSettingsItems", () => {
	test("four rows with the spec'd ids, labels, and value cycles", () => {
		const items = buildSettingsItems(DEFAULT_SETTINGS);
		expect(items.map((i) => i.id)).toEqual(["mcp", "webTools", "imageTools", "searchProvider"]);
		expect(items[0]).toMatchObject({ currentValue: "on", values: ["on", "off"] });
		expect(items[1]).toMatchObject({ currentValue: "on", values: ["on", "off"] });
		expect(items[2]).toMatchObject({ currentValue: "on", values: ["on", "off"] });
		expect(items[3]).toMatchObject({ currentValue: "server", values: ["server", "brave", "exa", "kagi"] });
	});

	test("reflects the current settings values", () => {
		const settings: LunarouteSettings = { mcp: "off", webTools: "off", searchProvider: "kagi", imageTools: "on" };
		const items = buildSettingsItems(settings);
		expect(items.map((i) => i.currentValue)).toEqual(["off", "off", "on", "kagi"]);
	});
});

// ============================================================================
// createSettingChangeApplier
// ============================================================================

describe("createSettingChangeApplier", () => {
	test("writes the file before applying (source of truth first)", async () => {
		const { pi, bus } = fakePi();
		const { dispose } = installFakeAdapter(bus);
		const order: string[] = [];
		const write = vi.fn(() => order.push("write"));
		const ui = { notify: vi.fn() };
		const deps = apierDeps({ write: write as never });
		const applier = createSettingChangeApplier(pi, deps, ui, async () => "lr_key", DEFAULT_SETTINGS);
		dispose.mockImplementation(async () => order.push("dispose"));
		// Register MCP first (as session_start would) so mcp-off has something to dispose.
		registerLunarouteMcp(pi, "lr_key", { env: ENV, version: "0.6.0-test", sessionId: "session-1" });
		expect(order).toEqual([]);
		await applier("mcp", "off");
		expect(write).toHaveBeenCalledWith(ENV, { ...DEFAULT_SETTINGS, mcp: "off" });
		expect(order).toEqual(["write", "dispose"]);
	});

	test("searchProvider: writes but applies nothing", async () => {
		const { pi } = fakePi();
		const write = vi.fn();
		const ui = { notify: vi.fn() };
		const applier = createSettingChangeApplier(pi, apierDeps({ write: write as never }), ui, async () => undefined, DEFAULT_SETTINGS);
		await applier("searchProvider", "kagi");
		expect(write).toHaveBeenCalledWith(ENV, { ...DEFAULT_SETTINGS, searchProvider: "kagi" });
		expect(ui.notify).not.toHaveBeenCalled();
		expect(pi.setActiveTools).not.toHaveBeenCalled();
	});

	test("write failure: error notify, nothing applied", async () => {
		const { pi, bus } = fakePi();
		installFakeAdapter(bus);
		const write = vi.fn(() => {
			throw new Error("disk full");
		});
		const ui = { notify: vi.fn() };
		const applier = createSettingChangeApplier(pi, apierDeps({ write: write as never }), ui, async () => "lr_key", DEFAULT_SETTINGS);
		await applier("mcp", "off");
		expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("disk full"), "error");
	});

	describe("imageTools", () => {
		const IMAGE_TOOLS_FETCH = mcpFetch({
			initialize: () => ({}),
			"notifications/initialized": () => undefined,
			"tools/list": () => ({
				tools: [
					{ name: "generate_image", inputSchema: { type: "object", properties: { model: { type: "string", enum: ["flux-2-klein"] } } } },
					{ name: "edit_image" },
					{ name: "upload_image" },
				],
			}),
		});

		test("off deactivates our image tools; on re-activates without re-registering", async () => {
			const { pi, getActive } = fakePi();
			await registerImageTools(pi, { key: "lr_key", env: ENV, version: "0.6.0-test", sessionId: "s", fetchImpl: IMAGE_TOOLS_FETCH });
			expect(getActive()).toContain("generate_image");
			const ui = { notify: vi.fn() };
			const applier = createSettingChangeApplier(pi, apierDeps(), ui, async () => "lr_key", DEFAULT_SETTINGS);
			await applier("imageTools", "off");
			expect(getActive()).not.toContain("generate_image");
			expect(getActive()).toContain("read");
			await applier("imageTools", "on");
			expect(getActive()).toContain("generate_image");
			expect(pi.registerTool).toHaveBeenCalledTimes(3);
			expect(ui.notify).toHaveBeenCalledWith("LunaRoute image tools disabled", "info");
			expect(ui.notify).toHaveBeenCalledWith("LunaRoute image tools enabled", "info");
		});

		test("on with nothing registered, key present, server offers → registers", async () => {
			const { pi, registered } = fakePi();
			const ui = { notify: vi.fn() };
			vi.stubGlobal("fetch", IMAGE_TOOLS_FETCH);
			try {
				const applier = createSettingChangeApplier(pi, apierDeps(), ui, async () => "lr_key", DEFAULT_SETTINGS);
				await applier("imageTools", "on");
				expect(registered.map((t) => t.name).sort()).toEqual(["edit_image", "generate_image", "upload_image"]);
				expect(ui.notify).toHaveBeenCalledWith("LunaRoute image tools enabled", "info");
			} finally {
				vi.unstubAllGlobals();
			}
		});

		test("on with nothing registered, key present, server unreachable → warning", async () => {
			const { pi } = fakePi();
			const ui = { notify: vi.fn() };
			vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 503 })));
			try {
				const applier = createSettingChangeApplier(pi, apierDeps(), ui, async () => "lr_key", DEFAULT_SETTINGS);
				await applier("imageTools", "on");
				expect(ui.notify).toHaveBeenCalledWith("LunaRoute image tools unavailable from the server right now.", "warning");
			} finally {
				vi.unstubAllGlobals();
			}
		});

		test("on with nothing registered and no key → login hint", async () => {
			const { pi } = fakePi();
			const ui = { notify: vi.fn() };
			const applier = createSettingChangeApplier(pi, apierDeps(), ui, async () => undefined, DEFAULT_SETTINGS);
			await applier("imageTools", "on");
			expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("/login lunaroute"), "info");
			expect(pi.registerTool).not.toHaveBeenCalled();
		});
	});

	describe("webTools", () => {
		test("off removes only our registered tools, not another extension's same-named tool", async () => {
			// Another extension's web_search is registered and active; we have none.
			const { pi, getActive } = fakePi({ toolNames: ["web_search"], activeTools: ["read", "web_search"] });
			const ui = { notify: vi.fn() };
			const applier = createSettingChangeApplier(pi, apierDeps(), ui, async () => "lr_key", DEFAULT_SETTINGS);
			await applier("webTools", "off");
			expect(getActive()).toEqual(["read", "web_search"]); // untouched
			expect(ui.notify).toHaveBeenCalledWith("LunaRoute web tools disabled", "info");
		});

		test("off deactivates our web_search; on re-activates it without re-registering", async () => {
			const { pi, getActive } = fakePi();
			// Register ours via the real path (populates getRegisteredWebToolNames).
			await registerWebTools(pi, {
				key: "lr_key",
				env: ENV,
				version: "0.6.0-test",
				sessionId: "s",
				fetchImpl: WEB_TOOLS_FETCH,
			});
			expect(getActive()).toContain("web_search");
			const write = vi.fn();
			const ui = { notify: vi.fn() };
			const applier = createSettingChangeApplier(pi, apierDeps({ write: write as never }), ui, async () => "lr_key", DEFAULT_SETTINGS);
			await applier("webTools", "off");
			expect(getActive()).not.toContain("web_search");
			expect(getActive()).toContain("read");
			await applier("webTools", "on");
			expect(getActive()).toContain("web_search");
			// Re-activation only: no second registration of the tool.
			expect(pi.registerTool).toHaveBeenCalledTimes(1);
			expect(ui.notify).toHaveBeenCalledWith("LunaRoute web tools enabled", "info");
		});

		test("on with nothing registered and no key → login hint", async () => {
			const { pi } = fakePi();
			const ui = { notify: vi.fn() };
			const applier = createSettingChangeApplier(pi, apierDeps(), ui, async () => undefined, DEFAULT_SETTINGS);
			await applier("webTools", "on");
			expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("/login lunaroute"), "info");
			expect(pi.registerTool).not.toHaveBeenCalled();
		});

		test("on with nothing registered, key present, server offers → registers", async () => {
			const { pi, registered } = fakePi();
			const ui = { notify: vi.fn() };
			// registerWebTools falls back to global fetch — stub the hosted server.
			vi.stubGlobal(
				"fetch",
				vi.fn(async () =>
					new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [{ name: "web_search" }] } }), {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
			),
		);
			const applier = createSettingChangeApplier(pi, apierDeps(), ui, async () => "lr_key", DEFAULT_SETTINGS);
			try {
				await applier("webTools", "on");
			} finally {
				vi.unstubAllGlobals();
			}
			expect(registered.map((t) => t.name)).toEqual(["web_search"]);
			expect(ui.notify).toHaveBeenCalledWith("LunaRoute web tools enabled", "info");
		});
	});

	describe("mcp", () => {
		test("off disposes the current registration", async () => {
			const { pi, bus } = fakePi();
			const { dispose, requests } = installFakeAdapter(bus);
			// Register first, like session_start would.
			const ui = { notify: vi.fn() };
			const applierOn = createSettingChangeApplier(pi, apierDeps(), ui, async () => "lr_key", DEFAULT_SETTINGS);
			await applierOn("mcp", "on");
			expect(requests).toHaveLength(1);
			expect(dispose).not.toHaveBeenCalled();
			await applierOn("mcp", "off");
			expect(dispose).toHaveBeenCalled();
			expect(ui.notify).toHaveBeenCalledWith("LunaRoute MCP disabled", "info");
		});

		test("on defers to a user-configured LunaRoute MCP (notice, no registration)", async () => {
			_setAdapterConfigLoader(async () => ({
				mcpServers: { lunaroute: { url: "https://mcp.lunaroute.com/mcp" } },
			}));
			const { pi, bus } = fakePi();
			const { requests } = installFakeAdapter(bus);
			const ui = { notify: vi.fn() };
			const applier = createSettingChangeApplier(pi, apierDeps(), ui, async () => "lr_key", DEFAULT_SETTINGS);
			await applier("mcp", "on");
			expect(requests).toHaveLength(0);
			expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("already configured"), "info");
		});

		test("on with key and adapter → registers", async () => {
			const { pi, bus } = fakePi();
			const { requests } = installFakeAdapter(bus);
			const ui = { notify: vi.fn() };
			const applier = createSettingChangeApplier(pi, apierDeps(), ui, async () => "lr_key", DEFAULT_SETTINGS);
			await applier("mcp", "on");
			expect(requests).toHaveLength(1);
			expect(ui.notify).toHaveBeenCalledWith("LunaRoute MCP enabled", "info");
		});

		test("on without a key → login hint", async () => {
			const { pi, bus } = fakePi();
			const { requests } = installFakeAdapter(bus);
			const ui = { notify: vi.fn() };
			const applier = createSettingChangeApplier(pi, apierDeps(), ui, async () => undefined, DEFAULT_SETTINGS);
			await applier("mcp", "on");
			expect(requests).toHaveLength(0);
			expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("/login lunaroute"), "info");
		});
	});
});

// ============================================================================
// registerLunarouteSettingsCommand
// ============================================================================

describe("registerLunarouteSettingsCommand", () => {
	function commandPi() {
		const { pi } = fakePi();
		registerLunarouteSettingsCommand(pi, { env: ENV, version: "0.6.0-test", sessionId: "s" });
		const call = (pi.registerCommand as ReturnType<typeof vi.fn>).mock.calls[0] as [
			string,
			{ description?: string; handler: (args: string, ctx: unknown) => Promise<void> },
		];
		return { pi, name: call[0], options: call[1] };
	}

	function fakeCtx(overrides: Record<string, unknown> = {}) {
		const notify = vi.fn();
		const custom = vi.fn();
		return {
			ctx: {
				hasUI: true,
				mode: "tui",
				modelRegistry: { getApiKeyForProvider: vi.fn(async () => "lr_key") },
				ui: { notify, custom },
				...overrides,
			},
			notify,
			custom,
		};
	}

	test("registers the /lunaroute command", () => {
		const { name, options } = commandPi();
		expect(name).toBe("lunaroute");
		expect(options.description).toContain("settings");
	});

	test("no UI (print mode): silent no-op", async () => {
		const { options } = commandPi();
		const { ctx, custom, notify } = fakeCtx({ hasUI: false, mode: "print" });
		await options.handler("", ctx);
		expect(custom).not.toHaveBeenCalled();
		expect(notify).not.toHaveBeenCalled();
	});

	test("RPC mode: notify points at the settings file", async () => {
		const { options } = commandPi();
		const { ctx, custom, notify } = fakeCtx({ mode: "rpc" });
		await options.handler("", ctx);
		expect(custom).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("/tmp/bjy9-agent/lunaroute.json"), "info");
	});

	test("TUI mode: renders the list; driving webTools on→off writes the file", async () => {
		const { pi, options } = commandPi();
		const write = vi.fn();
		registerLunarouteSettingsCommand(pi, {
			env: ENV,
			version: "0.6.0-test",
			sessionId: "s",
			write: write as never,
		});
		const call = (pi.registerCommand as ReturnType<typeof vi.fn>).mock.calls.at(-1) as [
			string,
			{ handler: (args: string, ctx: unknown) => Promise<void> },
		];
		const { ctx, custom } = fakeCtx();
		let component: { render: (w: number) => string[]; handleInput: (data: string) => void } | undefined;
		(custom as ReturnType<typeof vi.fn>).mockImplementation(
			async (factory: (tui: unknown, theme: unknown, kb: unknown, done: (v?: unknown) => void) => unknown) => {
				const theme = {
					fg: (_c: string, text: string) => text,
					bold: (text: string) => text,
				};
				component = factory({}, theme, {}, vi.fn()) as typeof component;
			},
		);
		await call[1].handler("", ctx);
		expect(custom).toHaveBeenCalled();
		expect(component).toBeTruthy();
		const lines = component!.render(80).join("\n");
		expect(lines).toContain("LunaRoute");
		expect(lines).toContain("Logged in");
		// Down once → webTools row; return cycles on → off; the change is
		// written through the injected write.
		component!.handleInput("\x1b[B");
		component!.handleInput("\r");
		await new Promise((r) => setTimeout(r, 0)); // applier runs void-async
		expect(write).toHaveBeenCalledWith(ENV, { ...DEFAULT_SETTINGS, webTools: "off" });
	});
});
