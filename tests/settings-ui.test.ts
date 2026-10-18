import { initTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { DEFAULT_SETTINGS, type LunarouteSettings } from "../src/settings.js";
import {
	buildSettingsItems,
	createSettingChangeApplier,
	runUsageCommand,
	registerLunarouteSettingsCommand,
	type SettingsCommandDeps,
} from "../src/settings-ui.js";
import { _resetImageToolsState, registerImageTools } from "../src/image-tools.js";
import { _resetInsightsState, isInsightsOn } from "../src/usage.js";
import { _resetConvertToolsState, registerConvertTools } from "../src/convert-tools.js";
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
	_resetConvertToolsState();
	_resetWebToolsState();
});

// ============================================================================
// buildSettingsItems (pure)
// ============================================================================

describe("buildSettingsItems", () => {
	test("seven rows with the spec'd ids, labels, and value cycles", () => {
		const items = buildSettingsItems(DEFAULT_SETTINGS);
		expect(items.map((i) => i.id)).toEqual(["mcp", "webTools", "imageTools", "convertTools", "searchProvider", "usageInsights", "providerRetries"]);
		expect(items[0]).toMatchObject({ currentValue: "on", values: ["on", "off"] });
		expect(items[1]).toMatchObject({ currentValue: "on", values: ["on", "off"] });
		expect(items[2]).toMatchObject({ currentValue: "on", values: ["on", "off"] });
		expect(items[3]).toMatchObject({ currentValue: "on", values: ["on", "off"] });
		expect(items[4]).toMatchObject({ currentValue: "server", values: ["server", "brave", "exa", "kagi", "youcom"] });
		expect(items[5]).toMatchObject({ currentValue: "on", values: ["on", "off"] });
		expect(items[6]).toMatchObject({ currentValue: "2", values: ["0", "1", "2", "3", "4", "5"] });
	});

	test("reflects the current settings values", () => {
		const settings: LunarouteSettings = { mcp: "off", webTools: "off", searchProvider: "kagi", imageTools: "on", convertTools: "on", providerRetries: 2, usageInsights: "on" };
		const items = buildSettingsItems(settings);
		expect(items.map((i) => i.currentValue)).toEqual(["off", "off", "on", "on", "kagi", "on", "2"]);
	});
});

// ============================================================================
// createSettingChangeApplier
// ============================================================================

describe("createSettingChangeApplier", () => {
	test("writes the file before applying (source of truth first)", async () => {
		const { pi, getActive } = fakePi();
		// Register ours first (as session_start would) so the off-apply has
		// something to deactivate.
		await registerWebTools(pi, { key: "lr_key", env: ENV, version: "0.6.0-test", sessionId: "session-1", fetchImpl: WEB_TOOLS_FETCH });
		expect(getActive()).toContain("web_search");
		const write = vi.fn();
		const ui = { notify: vi.fn() };
		const applier = createSettingChangeApplier(pi, apierDeps({ write: write as never }), ui, async () => "lr_key", DEFAULT_SETTINGS);
		await applier("webTools", "off");
		expect(write).toHaveBeenCalledWith(ENV, { ...DEFAULT_SETTINGS, webTools: "off" });
		expect(getActive()).not.toContain("web_search");
		const writeOrder = (write as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
		const applyOrder = (pi.setActiveTools as ReturnType<typeof vi.fn>).mock.invocationCallOrder.at(-1)!;
		expect(writeOrder).toBeLessThan(applyOrder);
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
		const { pi } = fakePi();
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
			// On-toggle revalidates the server catalog (roborev job 1643) —
			// stub the hosted server for the re-check; the tools are still
			// offered, so they are re-activated without re-registration.
			// Same catalog the initial registration saw (including the model
			// enum) — so the re-check re-activates without re-registering.
			vi.stubGlobal("fetch", IMAGE_TOOLS_FETCH);
			try {
				await applier("imageTools", "on");
			} finally {
				vi.unstubAllGlobals();
			}
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

	describe("mcp (master switch, kata 4ws9)", () => {
		// One stub serves every family's discovery: tools/list returns the
		// full hosted-server catalog.
		const ALL_FAMILIES_FETCH = mcpFetch({
			initialize: () => ({}),
			"notifications/initialized": () => undefined,
			"tools/list": () => ({
				tools: [{ name: "web_search" }, { name: "generate_image" }, { name: "convert_document" }],
			}),
		});

		test("off deactivates every family whose toggle is on", async () => {
			const { pi, getActive } = fakePi();
			await registerWebTools(pi, { key: "lr_key", env: ENV, version: "0.6.0-test", sessionId: "s", fetchImpl: ALL_FAMILIES_FETCH });
			await registerImageTools(pi, { key: "lr_key", env: ENV, version: "0.6.0-test", sessionId: "s", fetchImpl: ALL_FAMILIES_FETCH });
			expect(getActive()).toContain("web_search");
			expect(getActive()).toContain("generate_image");
			const ui = { notify: vi.fn() };
			const applier = createSettingChangeApplier(pi, apierDeps(), ui, async () => "lr_key", DEFAULT_SETTINGS);
			await applier("mcp", "off");
			expect(getActive()).not.toContain("web_search");
			expect(getActive()).not.toContain("generate_image");
			// All three families have their toggle on, so all three are driven
			// off — convert had nothing registered but still reports the off.
			expect(ui.notify).toHaveBeenCalledWith("LunaRoute web tools disabled", "info");
			expect(ui.notify).toHaveBeenCalledWith("LunaRoute image tools disabled", "info");
			expect(ui.notify).toHaveBeenCalledWith("LunaRoute convert tools disabled", "info");
		});

		test("on registers every family whose own toggle is on", async () => {
			const { pi, registered } = fakePi();
			const ui = { notify: vi.fn() };
			vi.stubGlobal("fetch", ALL_FAMILIES_FETCH);
			try {
				const applier = createSettingChangeApplier(pi, apierDeps(), ui, async () => "lr_key", DEFAULT_SETTINGS);
				await applier("mcp", "on");
				const names = registered.map((t) => t.name);
				expect(names).toContain("web_search");
				expect(names).toContain("generate_image");
				expect(names).toContain("convert_document");
			} finally {
				vi.unstubAllGlobals();
			}
		});

		test("on leaves families whose own toggle is off alone", async () => {
			const settings: LunarouteSettings = { ...DEFAULT_SETTINGS, webTools: "off" };
			const { pi, registered } = fakePi();
			const ui = { notify: vi.fn() };
			vi.stubGlobal("fetch", ALL_FAMILIES_FETCH);
			try {
				const applier = createSettingChangeApplier(pi, apierDeps(), ui, async () => "lr_key", settings);
				await applier("mcp", "on");
				const names = registered.map((t) => t.name);
				expect(names).not.toContain("web_search");
				expect(names).toContain("generate_image");
				expect(names).toContain("convert_document");
				// The web family was skipped wholesale — no web notify at all.
				const webNotifies = (ui.notify.mock.calls as string[][]).filter((c) => c[0].includes("web tools"));
				expect(webNotifies).toHaveLength(0);
			} finally {
				vi.unstubAllGlobals();
			}
		});

		test("off with a family already off stays silent for that family", async () => {
			const settings: LunarouteSettings = { ...DEFAULT_SETTINGS, webTools: "off" };
			const { pi } = fakePi();
			const ui = { notify: vi.fn() };
			const applier = createSettingChangeApplier(pi, apierDeps(), ui, async () => "lr_key", settings);
			await applier("mcp", "off");
			const webNotifies = (ui.notify.mock.calls as string[][]).filter((c) => c[0].includes("web tools"));
			expect(webNotifies).toHaveLength(0);
		});

		test("on without a key → login hints from the families that apply", async () => {
			const { pi, registered } = fakePi();
			const ui = { notify: vi.fn() };
			vi.stubGlobal("fetch", ALL_FAMILIES_FETCH);
			try {
				const applier = createSettingChangeApplier(pi, apierDeps(), ui, async () => undefined, DEFAULT_SETTINGS);
				await applier("mcp", "on");
				expect(registered).toHaveLength(0);
				const loginHints = (ui.notify.mock.calls as string[][]).filter((c) => c[0].includes("/login lunaroute"));
				expect(loginHints.length).toBeGreaterThan(0);
			} finally {
				vi.unstubAllGlobals();
			}
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
		const select = vi.fn();
		return {
			ctx: {
				hasUI: true,
				mode: "tui",
				modelRegistry: {
					getApiKeyForProvider: vi.fn(async () => "lr_key"),
					refresh: vi.fn(async () => ({ aborted: false, errors: new Map() })),
					getAvailable: vi.fn(() => []),
				},
				ui: { notify, custom, select },
				...overrides,
			},
			notify,
			custom,
			select,
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

	test("TUI mode: /lunaroute settings renders the list; driving webTools on→off writes the file", async () => {
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
		await call[1].handler("settings", ctx);
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

	test("bare command: offers Settings and Refresh models; Settings opens the list", async () => {
		const { pi, options } = commandPi();
		const { ctx, custom, select } = fakeCtx();
		select.mockResolvedValue("Settings");
		(custom as ReturnType<typeof vi.fn>).mockImplementation(async () => {});
		await options.handler("", ctx);
		expect(select).toHaveBeenCalledWith("LunaRoute", ["Settings", "Refresh models", "Usage"]);
		expect(custom).toHaveBeenCalled();
		expect(ctx.modelRegistry.refresh).not.toHaveBeenCalled();
	});

	test("bare command: choosing Refresh models reloads the catalog", async () => {
		const { options } = commandPi();
		const { ctx, select, notify } = fakeCtx();
		select.mockResolvedValue("Refresh models");
		(ctx.modelRegistry.getAvailable as ReturnType<typeof vi.fn>).mockReturnValue([
			{ provider: "lunaroute", id: "meta-muse-1" },
		]);
		await options.handler("", ctx);
		expect(ctx.modelRegistry.refresh).toHaveBeenCalledTimes(1);
		expect(notify).toHaveBeenCalledWith("LunaRoute models reloaded — 1 available", "info");
	});

	test("bare command: dismissing the menu does nothing", async () => {
		const { options } = commandPi();
		const { ctx, select, notify } = fakeCtx();
		select.mockResolvedValue(undefined);
		await options.handler("", ctx);
		expect(ctx.modelRegistry.refresh).not.toHaveBeenCalled();
		expect(notify).not.toHaveBeenCalled();
	});

	test("unknown arg: usage points at both subcommands", async () => {
		const { options } = commandPi();
		const { ctx, notify, custom } = fakeCtx();
		await options.handler("bogus", ctx);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("models-refresh"), "info");
		expect(notify.mock.calls[0][0]).toContain("settings");
		expect(custom).not.toHaveBeenCalled();
		expect(ctx.modelRegistry.refresh).not.toHaveBeenCalled();
	});

	test("models-refresh: reloads lunaroute over the network and reports the count", async () => {
		const { options } = commandPi();
		const { ctx, notify } = fakeCtx();
		(ctx.modelRegistry.getAvailable as ReturnType<typeof vi.fn>).mockReturnValue([
			{ provider: "lunaroute", id: "meta-muse-1" },
			{ provider: "anthropic", id: "claude" },
		]);
		await options.handler("models-refresh", ctx);
		expect(ctx.modelRegistry.refresh).toHaveBeenCalledWith({
			providers: ["lunaroute"],
			allowNetwork: true,
			signal: expect.any(AbortSignal),
		});
		expect(notify).toHaveBeenCalledWith("LunaRoute models reloaded — 1 available", "info");
	});

	test("models-refresh: a provider error is reported as an error, with a login hint on 401", async () => {
		const { options } = commandPi();
		const { ctx, notify } = fakeCtx();
		(ctx.modelRegistry.refresh as ReturnType<typeof vi.fn>).mockResolvedValue({
			aborted: false,
			errors: new Map([["lunaroute", new Error("HTTP 401")]]),
		});
		await options.handler("models-refresh", ctx);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("HTTP 401"), "error");
		expect(notify.mock.calls[0][0]).toContain("/login lunaroute");
		expect(notify.mock.calls[0][0]).not.toContain("reloaded");
	});

	test("models-refresh: a timed-out refresh is reported as an error", async () => {
		const { options } = commandPi();
		const { ctx, notify } = fakeCtx();
		(ctx.modelRegistry.refresh as ReturnType<typeof vi.fn>).mockResolvedValue({ aborted: true, errors: new Map() });
		await options.handler("models-refresh", ctx);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("timed out"), "error");
	});

	test("models-refresh: without a key, tells the user to log in and never refreshes", async () => {
		const { options } = commandPi();
		const { ctx, notify } = fakeCtx();
		(ctx.modelRegistry.getApiKeyForProvider as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
		await options.handler("models-refresh", ctx);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("/login lunaroute"), "info");
		expect(ctx.modelRegistry.refresh).not.toHaveBeenCalled();
	});

	test("models-refresh works in RPC mode too (no TUI needed)", async () => {
		const { options } = commandPi();
		const { ctx, notify } = fakeCtx({ mode: "rpc" });
		await options.handler("models-refresh", ctx);
		expect(ctx.modelRegistry.refresh).toHaveBeenCalledTimes(1);
		expect(notify).not.toHaveBeenCalledWith(expect.stringContaining("lunaroute.json"), "info");
	});
});

describe("imageTools on-toggle revalidation (roborev job 1643)", () => {
	beforeEach(() => {
		vi.unstubAllEnvs();
		_resetImageToolsState();
	});

	test("on re-activates only what the server still offers", async () => {
		const { pi, getActive } = fakePi();
		const fullFetch = mcpFetch({
			initialize: () => ({}),
			"notifications/initialized": () => undefined,
			"tools/list": () => ({ tools: [{ name: "generate_image" }, { name: "upload_image" }] }),
		});
		await registerImageTools(pi, { key: "lr_key", env: ENV, version: "0.6.0-test", sessionId: "s", fetchImpl: fullFetch });
		expect(getActive()).toContain("upload_image");

		const ui = { notify: vi.fn() };
		const applier = createSettingChangeApplier(pi, apierDeps(), ui, async () => "lr_key", DEFAULT_SETTINGS);
		await applier("imageTools", "off");
		expect(getActive()).not.toContain("upload_image");

		// The server stopped offering upload_image while we were off.
		vi.stubGlobal(
			"fetch",
			mcpFetch({
				initialize: () => ({}),
				"notifications/initialized": () => undefined,
				"tools/list": () => ({ tools: [{ name: "generate_image" }] }),
			}),
		);
		try {
			await applier("imageTools", "on");
			expect(getActive()).toContain("generate_image");
			expect(getActive()).not.toContain("upload_image");
			expect(ui.notify).toHaveBeenCalledWith("LunaRoute image tools enabled", "info");
		} finally {
			vi.unstubAllGlobals();
		}
	});
});

describe("imageTools off during discovery supersedes (roborev job 1649)", () => {
	beforeEach(() => {
		vi.unstubAllEnvs();
		_resetImageToolsState();
	});

	test("applier off while a registration is in flight: tools never activate", async () => {
		const { pi, getActive } = fakePi();
		let resolveA: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			resolveA = resolve;
		});
		let listStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			listStarted = resolve;
		});
		const deferredFetch = async (_url: string, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body)) as { id: number; method: string };
			if (body.method === "tools/list") {
				listStarted(); // the fetch is attached and parked — deterministic
				await gate;
				return new Response(
					JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "generate_image" }, { name: "upload_image" }] } }),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}
			return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} }), { status: 200, headers: { "content-type": "application/json" } });
		};
		vi.stubGlobal("fetch", deferredFetch);
		const ui = { notify: vi.fn() };
		const applier = createSettingChangeApplier(pi, apierDeps(), ui, async () => "lr_key", DEFAULT_SETTINGS);
		// The on-toggle starts a registration whose catalog fetch parks…
		const on = applier("imageTools", "on");
		await started;
		// …and the user flips it off before the catalog resolves.
		await applier("imageTools", "off");
		resolveA();
		await on;
		try {
			expect(getActive()).not.toContain("generate_image");
			expect(getActive()).not.toContain("upload_image");
			expect(getActive()).toEqual(expect.arrayContaining(["read", "bash"]));
		} finally {
			vi.unstubAllGlobals();
		}
	});
});

describe("imageTools apply supersession (roborev job 1669)", () => {
	beforeEach(() => {
		vi.unstubAllEnvs();
		_resetImageToolsState();
	});

	test("an on-apply superseded by a later off toggle never activates", async () => {
		const { pi, getActive } = fakePi();
		let resolveKey!: (key: string | undefined) => void;
		const keyPromise = new Promise<string | undefined>((resolve) => {
			resolveKey = resolve;
		});
		vi.stubGlobal(
			"fetch",
			mcpFetch({
				initialize: () => ({}),
				"notifications/initialized": () => undefined,
				"tools/list": () => ({ tools: [{ name: "generate_image" }, { name: "upload_image" }] }),
			}),
		);
		const ui = { notify: vi.fn() };
		const applier = createSettingChangeApplier(pi, apierDeps(), ui, () => keyPromise, DEFAULT_SETTINGS);
		try {
			// The on-apply parks at the deferred key lookup…
			const on = applier("imageTools", "on");
			// …the user flips it off before the key resolves…
			await applier("imageTools", "off");
			resolveKey("lr_key");
			await on;
			// …so the stale on-apply must not register or activate anything.
			expect(getActive()).not.toContain("generate_image");
			expect(getActive()).not.toContain("upload_image");
			expect(pi.registerTool).not.toHaveBeenCalled();
		} finally {
			vi.unstubAllGlobals();
		}
	});
});

describe("convertTools applier (kata zpzt)", () => {
	beforeEach(() => {
		vi.unstubAllEnvs();
		_resetConvertToolsState();
	});

	const CONVERT_FETCH = mcpFetch({
		initialize: () => ({}),
		"notifications/initialized": () => undefined,
		"tools/list": () => ({ tools: [{ name: "convert_document" }] }),
	});

	test("off deactivates our tool and invalidates; on revalidates via the server", async () => {
		const { pi, getActive } = fakePi();
		await registerConvertTools(pi, { key: "lr_key", env: ENV, version: "0.6.0-test", sessionId: "s", fetchImpl: CONVERT_FETCH });
		expect(getActive()).toContain("convert_document");
		const ui = { notify: vi.fn() };
		const applier = createSettingChangeApplier(pi, apierDeps(), ui, async () => "lr_key", DEFAULT_SETTINGS);
		await applier("convertTools", "off");
		expect(getActive()).not.toContain("convert_document");
		expect(ui.notify).toHaveBeenCalledWith("LunaRoute convert tools disabled", "info");
		vi.stubGlobal("fetch", CONVERT_FETCH);
		try {
			await applier("convertTools", "on");
			expect(getActive()).toContain("convert_document");
			expect(pi.registerTool).toHaveBeenCalledTimes(1); // no re-registration
			expect(ui.notify).toHaveBeenCalledWith("LunaRoute convert tools enabled", "info");
		} finally {
			vi.unstubAllGlobals();
		}
	});

	test("on with nothing registered and no key → login hint", async () => {
		const { pi } = fakePi();
		const ui = { notify: vi.fn() };
		const applier = createSettingChangeApplier(pi, apierDeps(), ui, async () => undefined, DEFAULT_SETTINGS);
		await applier("convertTools", "on");
		expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("/login lunaroute"), "info");
		expect(pi.registerTool).not.toHaveBeenCalled();
	});

	test("an on-apply superseded by a later off toggle never activates", async () => {
		const { pi, getActive } = fakePi();
		let resolveKey!: (key: string | undefined) => void;
		const keyPromise = new Promise<string | undefined>((resolve) => {
			resolveKey = resolve;
		});
		vi.stubGlobal("fetch", CONVERT_FETCH);
		const ui = { notify: vi.fn() };
		const applier = createSettingChangeApplier(pi, apierDeps(), ui, () => keyPromise, DEFAULT_SETTINGS);
		try {
			const on = applier("convertTools", "on");
			await applier("convertTools", "off");
			resolveKey("lr_key");
			await on;
			expect(getActive()).not.toContain("convert_document");
			expect(pi.registerTool).not.toHaveBeenCalled();
		} finally {
			vi.unstubAllGlobals();
		}
	});
});

// ============================================================================
// providerRetries (kata z5y7)
// ============================================================================

describe("providerRetries row", () => {
	test("offers the full 0..5 cycle and reflects the current value", () => {
		const items = buildSettingsItems({ ...DEFAULT_SETTINGS, providerRetries: 3 });
		const row = items.find((i) => i.id === "providerRetries");
		expect(row).toMatchObject({ currentValue: "3", values: ["0", "1", "2", "3", "4", "5"] });
	});

	test("applier writes a number and applies nothing (next request reads it)", async () => {
		const { pi } = fakePi();
		const write = vi.fn();
		const ui = { notify: vi.fn() };
		const applier = createSettingChangeApplier(pi, apierDeps({ write: write as never }), ui, async () => undefined, DEFAULT_SETTINGS);
		await applier("providerRetries", "4");
		expect(write).toHaveBeenCalledWith(ENV, { ...DEFAULT_SETTINGS, providerRetries: 4 });
		expect(ui.notify).not.toHaveBeenCalled();
		expect(pi.setActiveTools).not.toHaveBeenCalled();
	});
});

// ============================================================================
// /lunaroute usage (kata: usage insights)
// ============================================================================

describe("runUsageCommand", () => {
	const DEPS: SettingsCommandDeps = { env: ENV, version: "0.6.0-test", sessionId: "s" };
	const STATS = { requests: 2, totalMs: 120, maxMs: 100, lastMs: 20 };
	const SNAPSHOT = {
		plan: { id: "pro", name: "Pro", interactiveLanes: 4 },
		period: { start: "2026-10-01T00:00:00Z", end: "2026-10-31T00:00:00Z" },
		totals: { requests: 812, queuedMs: 482000, requestMs: 1900000, rejected: 3, rejectQueuedMs: 142000 },
		status: "elevated" as const,
	};

	function ctxWith(key: string | undefined) {
		const notify = vi.fn();
		return {
			ctx: {
				ui: { notify },
				modelRegistry: { getApiKeyForProvider: vi.fn(async () => key) },
			},
			notify,
		};
	}

	function snapshotClient(snapshot: unknown) {
		return () => ({
			listTools: async () => [],
			callTool: async () => ({ content: [{ type: "text", text: JSON.stringify(snapshot) }] }),
		});
	}

	test("says off when insights are disabled, after the key check", async () => {
		const { ctx, notify } = ctxWith("lr_key");
		await runUsageCommand(
			ctx,
			{ ...DEPS, read: () => ({ ...DEFAULT_SETTINGS, usageInsights: "off" }) },
			() => STATS,
			snapshotClient(SNAPSHOT),
		);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("off"), "info");
	});

	test("a missing key wins over the off message", async () => {
		const { ctx, notify } = ctxWith(undefined);
		await runUsageCommand(
			ctx,
			{ ...DEPS, read: () => ({ ...DEFAULT_SETTINGS, usageInsights: "off" }) },
			() => STATS,
			snapshotClient(SNAPSHOT),
		);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("/login lunaroute"), "info");
		expect(notify.mock.calls[0][0]).not.toContain("insights are off");
	});

	test("reports the snapshot and the session stats", async () => {
		const { ctx, notify } = ctxWith("lr_key");
		await runUsageCommand(ctx, { ...DEPS, read: () => DEFAULT_SETTINGS }, () => STATS, snapshotClient(SNAPSHOT));
		const text = notify.mock.calls[0][0] as string;
		expect(text).toContain("Pro");
		expect(text).toContain("4 lanes");
		expect(text).toContain("3 rejected");
		expect(text).toContain("this session: 2 requests");
	});

	test("falls back to session stats when the tool call fails", async () => {
		const { ctx, notify } = ctxWith("lr_key");
		await runUsageCommand(ctx, { ...DEPS, read: () => DEFAULT_SETTINGS }, () => STATS, () => ({
			listTools: async () => [],
			callTool: async () => {
				throw new Error("HTTP 500");
			},
		}));
		const text = notify.mock.calls[0][0] as string;
		expect(text).toContain("usage unavailable");
		expect(text).toContain("this session: 2 requests");
	});
});

describe("/lunaroute usage routing", () => {
	test("the subcommand is reachable and reports the login hint without a key", async () => {
		const { pi } = fakePi();
		registerLunarouteSettingsCommand(pi, { env: ENV, version: "0.6.0-test", sessionId: "s" });
		const call = (pi.registerCommand as ReturnType<typeof vi.fn>).mock.calls[0] as [
			string,
			{ handler: (args: string, ctx: unknown) => Promise<void> },
		];
		const notify = vi.fn();
		await call[1].handler("usage", {
			hasUI: true,
			mode: "tui",
			modelRegistry: { getApiKeyForProvider: vi.fn(async () => undefined) },
			ui: { notify, custom: vi.fn(), select: vi.fn() },
		});
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("/login lunaroute"), "info");
	});

	test("the bare menu offers Usage", async () => {
		const { pi } = fakePi();
		registerLunarouteSettingsCommand(pi, { env: ENV, version: "0.6.0-test", sessionId: "s" });
		const call = (pi.registerCommand as ReturnType<typeof vi.fn>).mock.calls[0] as [
			string,
			{ handler: (args: string, ctx: unknown) => Promise<void> },
		];
		const select = vi.fn(async (_title: string, _options: string[]) => undefined as string | undefined);
		await call[1].handler("", {
			hasUI: true,
			mode: "tui",
			modelRegistry: { getApiKeyForProvider: vi.fn(async () => undefined) },
			ui: { notify: vi.fn(), custom: vi.fn(), select },
		});
		expect(select.mock.calls[0][1]).toContain("Usage");
	});
});

describe("usageInsights setting row", () => {
	test("the settings list offers the usageInsights toggle", () => {
		expect(buildSettingsItems(DEFAULT_SETTINGS).map((i) => i.id)).toContain("usageInsights");
	});

	test("toggling the row updates the shared gate immediately", async () => {
		_resetInsightsState();
		const { pi } = fakePi();
		const ui = { notify: vi.fn() };
		const applier = createSettingChangeApplier(
			pi,
			{ env: ENV, version: "t", sessionId: "s", write: vi.fn() as never },
			ui,
			async () => undefined,
			DEFAULT_SETTINGS,
		);
		await applier("usageInsights", "off");
		expect(isInsightsOn()).toBe(false);
		await applier("usageInsights", "on");
		expect(isInsightsOn()).toBe(true);
	});

	test("the env override still wins over a live on-toggle", async () => {
		_resetInsightsState();
		vi.stubEnv("LUNAROUTE_USAGE_INSIGHTS", "off");
		const { pi } = fakePi();
		const applier = createSettingChangeApplier(
			pi,
			{ env: process.env, version: "t", sessionId: "s", write: vi.fn() as never },
			{ notify: vi.fn() },
			async () => undefined,
			{ ...DEFAULT_SETTINGS, usageInsights: "off" },
		);
		await applier("usageInsights", "on");
		expect(isInsightsOn()).toBe(false);
		vi.unstubAllEnvs();
	});
});
