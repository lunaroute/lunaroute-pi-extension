import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ModelsRefreshResult } from "@earendil-works/pi-ai";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, SettingsList, Text, type SettingItem } from "@earendil-works/pi-tui";
import { LUNAROUTE_PROVIDER, buildAttributionHeaders, resolveMcpUrl } from "./lunaroute.js";
import { PROVIDER_RETRIES_MAX, readSettings, settingsPath, writeSettings, usageInsightsEnabled, type LunarouteSettings } from "./settings.js";
import { getRegisteredImageToolNames, invalidateImageToolRegistrations, registerImageTools } from "./image-tools.js";
import { getRegisteredConvertToolNames, invalidateConvertToolRegistrations, registerConvertTools } from "./convert-tools.js";
import { getRegisteredWebToolNames, createLunarouteMcpClient, registerWebTools, type LunarouteMcpClient } from "./web-tools.js";
import { emptyStats, fetchUsage, formatUsageReport, setInsightsOn, type SessionQueueStats } from "./usage.js";

/** The `/lunaroute` settings command (kata bjy9): a pi-native SettingsList
 * TUI for MCP on/off, web tools on/off, and the default search provider.
 * Settings persist at `<agentDir>/lunaroute.json` and apply live where pi
 * allows. See docs/superpowers/specs/2026-09-08-bjy9-lunaroute-settings-tui-design.md.
 */

type NotifyFn = (message: string, type?: "info" | "warning" | "error") => void;

export interface SettingsCommandDeps {
	env: NodeJS.ProcessEnv;
	version: string;
	sessionId: string;
	/** Injectable for tests; defaults to the real file IO. */
	read?: typeof readSettings;
	write?: typeof writeSettings;
}

/** Pure: the SettingsList rows for the current settings. */
export function buildSettingsItems(settings: LunarouteSettings): SettingItem[] {
	return [
		{
			id: "mcp",
			label: "MCP tools",
			description: "Master switch for LunaRoute MCP-backed tools — each family below has its own toggle",
			currentValue: settings.mcp,
			values: ["on", "off"],
		},
		{
			id: "webTools",
			label: "Web search tools",
			description: "First-class web_search / web_fetch backed by LunaRoute",
			currentValue: settings.webTools,
			values: ["on", "off"],
		},
		{
			id: "imageTools",
			label: "Image tools",
			description: "First-class generate_image / edit_image / upload_image backed by LunaRoute",
			currentValue: settings.imageTools,
			values: ["on", "off"],
		},
		{
			id: "convertTools",
			label: "Convert tools",
			description: "First-class convert_document (docx/pdf/xlsx/… → Markdown) backed by LunaRoute",
			currentValue: settings.convertTools,
			values: ["on", "off"],
		},
		{
			id: "searchProvider",
			label: "Search provider",
			description: "Default provider for web_search; the model can still override per call",
			currentValue: settings.searchProvider,
			values: ["server", "brave", "exa", "kagi"],
		},
		{
			id: "usageInsights",
			label: "Usage insights",
			description: "Queue/usage messages and /lunaroute usage",
			currentValue: settings.usageInsights,
			values: ["on", "off"],
		},
		{
			id: "providerRetries",
			label: "Provider retries (429)",
			description: "Retries for model requests, honoring LunaRoute's Retry-After; 0 = off",
			currentValue: String(settings.providerRetries),
			values: Array.from({ length: PROVIDER_RETRIES_MAX + 1 }, (_, i) => String(i)),
		},
	];
}

export type SettingChangeApplier = (id: string, newValue: string) => Promise<void>;

/** Create the write-then-live-apply handler for one settings change.
 *
 * Order matters: the file is the source of truth and is written first; the
 * in-process application (setActiveTools / family register/deactivate) is an
 * optimization on top and must never throw past this boundary.
 *
 * The web-tools live-apply only ever touches tools this process registered
 * (getRegisteredWebToolNames) — another extension's same-named web_search is
 * not ours to disable. */
export function createSettingChangeApplier(
	pi: ExtensionAPI,
	deps: SettingsCommandDeps,
	ui: { notify: NotifyFn },
	getApiKey: () => Promise<string | undefined>,
	initialSettings: LunarouteSettings,
): SettingChangeApplier {
	const read = deps.read ?? readSettings;
	const write = deps.write ?? writeSettings;
	let settings = initialSettings;
	// Image-tools apply generation (roborev job 1669): an on-apply parked at
	// its key lookup must not resume past a newer toggle — the later apply
	// supersedes the earlier one wholesale.
	let imageToolsApplyGeneration = 0;
	let convertToolsApplyGeneration = 0;

	return async (id: string, newValue: string): Promise<void> => {
		settings = { ...settings, [id]: id === "providerRetries" ? Number(newValue) : newValue } as LunarouteSettings;
		try {
			write(deps.env, settings);
		} catch (err) {
			ui.notify(`Failed to save lunaroute.json: ${err instanceof Error ? err.message : String(err)}`, "error");
			return;
		}
		// Both are read at call time: searchProvider by web_search, providerRetries
		// by the model-request stream — no registration to swap.
		if (id === "searchProvider" || id === "providerRetries") return;
		if (id === "usageInsights") {
			// Recompute through the decision function: the env escape hatch must
			// stay authoritative over a live "on".
			setInsightsOn(usageInsightsEnabled(deps.env, settings));
			return;
		}
		try {
			if (id === "webTools") await applyWebTools(pi, deps, ui, getApiKey, settings, newValue === "on");
			if (id === "imageTools") {
				const generation = ++imageToolsApplyGeneration;
				await applyImageTools(
					pi,
					deps,
					ui,
					getApiKey,
					settings,
					newValue === "on",
					() => generation === imageToolsApplyGeneration,
				);
			}
			if (id === "convertTools") {
				const generation = ++convertToolsApplyGeneration;
				await applyConvertTools(
					pi,
					deps,
					ui,
					getApiKey,
					settings,
					newValue === "on",
					() => generation === convertToolsApplyGeneration,
				);
			}
			if (id === "mcp") {
				// Master switch (kata 4ws9): drive each family toward its own
				// toggle — on activates families whose toggle is on, off
				// deactivates them. Families whose own toggle is off are untouched
				// in both directions (already in the requested state).
				const on = newValue === "on";
				if (settings.webTools === "on") {
					await applyWebTools(pi, deps, ui, getApiKey, settings, on);
				}
				if (settings.imageTools === "on") {
					const generation = ++imageToolsApplyGeneration;
					await applyImageTools(
						pi,
						deps,
						ui,
						getApiKey,
						settings,
						on,
						() => generation === imageToolsApplyGeneration,
					);
				}
				if (settings.convertTools === "on") {
					const generation = ++convertToolsApplyGeneration;
					await applyConvertTools(
						pi,
						deps,
						ui,
						getApiKey,
						settings,
						on,
						() => generation === convertToolsApplyGeneration,
					);
				}
			}
		} catch (err) {
			// Never throw from a SettingsList change callback.
			ui.notify(`LunaRoute settings applied partially: ${err instanceof Error ? err.message : String(err)}`, "warning");
		}
	};
}

async function applyWebTools(
	pi: ExtensionAPI,
	deps: SettingsCommandDeps,
	ui: { notify: NotifyFn },
	getApiKey: () => Promise<string | undefined>,
	settings: LunarouteSettings,
	on: boolean,
): Promise<void> {
	const ours = getRegisteredWebToolNames();
	if (!on) {
		if (ours.size > 0) {
			pi.setActiveTools(pi.getActiveTools().filter((name) => !ours.has(name)));
		}
		ui.notify("LunaRoute web tools disabled", "info");
		return;
	}
	if (ours.size > 0) {
		// Registered (possibly inactive after an off-toggle this session):
		// re-activate directly. registerWebTools would no-op here — its
		// detection sees the still-registered names in getAllTools().
		pi.setActiveTools([...new Set([...pi.getActiveTools(), ...ours])]);
		ui.notify("LunaRoute web tools enabled", "info");
		return;
	}
	const key = await getApiKey();
	if (!key) {
		ui.notify("Not logged in — run /login lunaroute to enable web search.", "info");
		return;
	}
	const result = await registerWebTools(pi, {
		key,
		env: deps.env,
		version: deps.version,
		sessionId: deps.sessionId,
		settings,
	});
	switch (result.webSearch) {
		case "registered":
			ui.notify("LunaRoute web tools enabled", "info");
			break;
		case "skipped-existing":
			ui.notify("Another extension already provides web search — LunaRoute's stays off.", "info");
			break;
		case "skipped-server":
			ui.notify("LunaRoute web search is unavailable from the server right now.", "warning");
			break;
		case "skipped-disabled":
			ui.notify("Disabled by the LUNAROUTE_WEB_TOOLS environment variable.", "warning");
			break;
	}
}

/** Register the `/lunaroute` command: bare (menu), `settings`, `models-refresh`, `usage`. */
export function registerLunarouteSettingsCommand(
	pi: ExtensionAPI,
	deps: SettingsCommandDeps,
	getQueueStats: () => SessionQueueStats = emptyStats,
): void {
	pi.registerCommand("lunaroute", {
		description: "LunaRoute settings, model catalog refresh, and usage",
		handler: async (args, ctx) => {
			const sub = args.trim();
			if (sub === "models-refresh") {
				await refreshModelsCommand(ctx);
				return;
			}
			if (sub === "settings") {
				await openSettingsCommand(pi, deps, ctx);
				return;
			}
			if (sub === "usage") {
				await runUsageCommand(ctx, deps, getQueueStats);
				return;
			}
			if (sub) {
				ctx.ui.notify(`Unknown option "${sub}" — use /lunaroute settings, models-refresh or usage`, "info");
				return;
			}
			if (!ctx.hasUI) return; // print/json modes: nothing to render
			if (ctx.mode !== "tui") {
				// The menu and the settings TUI both need a dialog-capable terminal.
				ctx.ui.notify(`Run /lunaroute in interactive mode, or edit ${settingsPath(deps.env)}`, "info");
				return;
			}
			const choice = await ctx.ui.select("LunaRoute", ["Settings", "Refresh models", "Usage"]);
			if (choice === "Settings") await openSettingsCommand(pi, deps, ctx);
			else if (choice === "Refresh models") await refreshModelsCommand(ctx);
			else if (choice === "Usage") await runUsageCommand(ctx, deps, getQueueStats);
		},
	});
}

/** Reload the model catalog now and report the outcome (kata a2jm). discovery
 * throws after restoring the stored catalog on a failed fetch, so pi records
 * the attempt as a provider error — success is only reported when it landed. */
async function refreshModelsCommand(ctx: ExtensionCommandContext): Promise<void> {
	const key = await ctx.modelRegistry.getApiKeyForProvider(LUNAROUTE_PROVIDER).catch(() => undefined);
	if (!key) {
		ctx.ui.notify("Not logged in — run /login lunaroute to refresh models.", "info");
		return;
	}
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 15_000);
	let result: ModelsRefreshResult;
	try {
		result = await ctx.modelRegistry.refresh({
			providers: [LUNAROUTE_PROVIDER],
			allowNetwork: true,
			signal: controller.signal,
		});
	} catch (error) {
		const detail = controller.signal.aborted ? "timed out" : error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`LunaRoute model refresh failed: ${detail}`, "error");
		return;
	} finally {
		clearTimeout(timeout);
	}
	if (result.aborted) {
		ctx.ui.notify("LunaRoute model refresh timed out — still showing the last known catalog.", "error");
		return;
	}
	const error = result.errors.get(LUNAROUTE_PROVIDER);
	if (error) {
		const detail = error.message || String(error);
		const hint = detail.includes("401") ? " — run /login lunaroute" : "";
		ctx.ui.notify(`LunaRoute model refresh failed: ${detail}${hint}`, "error");
		return;
	}
	const count = ctx.modelRegistry.getAvailable().filter((m) => m.provider === LUNAROUTE_PROVIDER).length;
	ctx.ui.notify(`LunaRoute models reloaded — ${count} available`, "info");
}

/** The settings-list TUI (kata bjy9): `/lunaroute settings` and the menu. */
async function openSettingsCommand(pi: ExtensionAPI, deps: SettingsCommandDeps, ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) return; // print/json modes: nothing to render
	if (ctx.mode !== "tui") {
		// RPC mode: ctx.ui.custom() is unavailable — point at the file.
		ctx.ui.notify(`Run /lunaroute in interactive mode, or edit ${settingsPath(deps.env)}`, "info");
		return;
	}
	const settings = (deps.read ?? readSettings)(deps.env);
	const key = await ctx.modelRegistry.getApiKeyForProvider(LUNAROUTE_PROVIDER).catch(() => undefined);
	const getApiKey = () => ctx.modelRegistry.getApiKeyForProvider(LUNAROUTE_PROVIDER).catch(() => undefined);
	const applier = createSettingChangeApplier(pi, deps, ctx.ui, getApiKey, settings);

	await ctx.ui.custom((_tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new Text(theme.fg("accent", theme.bold("LunaRoute")), 1, 1));
		container.addChild(
			new Text(
				key
					? theme.fg("success", "Logged in ✓")
					: theme.fg("dim", "Not logged in — run /login lunaroute"),
				1,
				0,
			),
		);
		const list = new SettingsList(
			buildSettingsItems(settings),
			5,
			getSettingsListTheme(),
			(id, newValue) => {
				list.updateValue(id, newValue);
				void applier(id, newValue);
			},
			() => done(undefined),
		);
		container.addChild(list);
		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => list.handleInput?.(data),
		};
	});
}

/** Image-tools live-apply (kata e30g). Mirrors applyWebTools minus the
 * presence-detection case — there is no "another extension already provides
 * generate_image" branch by design. */
async function applyImageTools(
	pi: ExtensionAPI,
	deps: SettingsCommandDeps,
	ui: { notify: NotifyFn },
	getApiKey: () => Promise<string | undefined>,
	settings: LunarouteSettings,
	on: boolean,
	isCurrent: () => boolean = () => true,
): Promise<void> {
	if (!on) {
		const ours = getRegisteredImageToolNames();
		if (ours.size > 0) {
			pi.setActiveTools(pi.getActiveTools().filter((name) => !ours.has(name)));
		}
		// An in-flight registration (catalog fetch still resolving) must not
		// land after this off-toggle and reactivate anything.
		invalidateImageToolRegistrations();
		ui.notify("LunaRoute image tools disabled", "info");
		return;
	}
	const key = await getApiKey();
	if (!isCurrent()) return; // a later toggle superseded this apply while parked
	if (!key) {
		ui.notify("Not logged in — run /login lunaroute to enable image tools.", "info");
		return;
	}
	// Always delegate — registerImageTools revalidates the server catalog on
	// every call: it reconciles away tools the server stopped offering and
	// re-activates (never re-registers) the ones it still does (roborev job
	// 1643).
	const result = await registerImageTools(pi, {
		key,
		env: deps.env,
		version: deps.version,
		sessionId: deps.sessionId,
		settings,
	});
	if (result.generateImage === "registered" || result.editImage === "registered" || result.uploadImage === "registered") {
		ui.notify("LunaRoute image tools enabled", "info");
	} else if (result.generateImage === "skipped-existing" || result.editImage === "skipped-existing" || result.uploadImage === "skipped-existing") {
		ui.notify("Another extension already provides image tools — LunaRoute's stays off.", "info");
	} else if (result.error !== undefined) {
		ui.notify("LunaRoute image tools unavailable from the server right now.", "warning");
	} else {
		ui.notify("LunaRoute image tools are not available for your organization.", "info");
	}
}

/** Convert-tools live-apply (kata zpzt). Mirrors applyImageTools: off
 * deactivates ours and invalidates in-flight registrations; on always
 * delegates to registerConvertTools, which revalidates the server catalog. */
async function applyConvertTools(
	pi: ExtensionAPI,
	deps: SettingsCommandDeps,
	ui: { notify: NotifyFn },
	getApiKey: () => Promise<string | undefined>,
	settings: LunarouteSettings,
	on: boolean,
	isCurrent: () => boolean = () => true,
): Promise<void> {
	if (!on) {
		const ours = getRegisteredConvertToolNames();
		if (ours.size > 0) {
			pi.setActiveTools(pi.getActiveTools().filter((name) => !ours.has(name)));
		}
		invalidateConvertToolRegistrations();
		ui.notify("LunaRoute convert tools disabled", "info");
		return;
	}
	const key = await getApiKey();
	if (!isCurrent()) return; // a later toggle superseded this apply while parked
	if (!key) {
		ui.notify("Not logged in — run /login lunaroute to enable convert tools.", "info");
		return;
	}
	const result = await registerConvertTools(pi, {
		key,
		env: deps.env,
		version: deps.version,
		sessionId: deps.sessionId,
		settings,
	});
	if (result.convert === "registered") {
		ui.notify("LunaRoute convert tools enabled", "info");
	} else if (result.convert === "skipped-existing") {
		ui.notify("Another extension already provides convert_document — LunaRoute's stays off.", "info");
	} else if (result.error !== undefined) {
		ui.notify("LunaRoute convert tools unavailable from the server right now.", "warning");
	} else {
		ui.notify("LunaRoute convert tools are not available for your organization.", "info");
	}
}

// ============================================================================
// /lunaroute usage
// ============================================================================

/** Builds the MCP client for the usage call; injectable for tests. */
export type UsageClientFactory = (key: string) => LunarouteMcpClient;

function defaultUsageClient(key: string, deps: SettingsCommandDeps): LunarouteMcpClient {
	return createLunarouteMcpClient({
		url: resolveMcpUrl(deps.env),
		// Same auth header the first-class MCP tools use.
		headers: { "LUNAROUTE-API-KEY": key, ...buildAttributionHeaders(deps.version, deps.sessionId) },
		fetchImpl: fetch,
	});
}

/** `/lunaroute usage`: the on-demand usage report.
 *
 * Login is checked first — without a key there is nothing to show, and the
 * login hint is the blocking next step. Then the insights toggle, then the
 * server's aggregate tool, falling back to this session's measured queueing
 * when the server does not answer. Never throws. */
export async function runUsageCommand(
	ctx: {
		ui: { notify(message: string, type?: "info" | "warning" | "error"): void };
		modelRegistry: { getApiKeyForProvider(provider: string): Promise<string | undefined> };
	},
	deps: SettingsCommandDeps,
	getQueueStats: () => SessionQueueStats = emptyStats,
	clientFactory?: UsageClientFactory,
): Promise<void> {
	const key = await ctx.modelRegistry.getApiKeyForProvider(LUNAROUTE_PROVIDER).catch(() => undefined);
	if (!key) {
		ctx.ui.notify("Not logged in — run /login lunaroute to see usage.", "info");
		return;
	}
	const settings = (deps.read ?? readSettings)(deps.env);
	if (!usageInsightsEnabled(deps.env, settings)) {
		ctx.ui.notify("Usage insights are off — enable in /lunaroute settings.", "info");
		return;
	}
	const client = (clientFactory ?? ((k: string) => defaultUsageClient(k, deps)))(key);
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 10_000);
	let snapshot;
	try {
		snapshot = await fetchUsage(client, controller.signal);
	} finally {
		clearTimeout(timeout);
	}
	ctx.ui.notify(formatUsageReport(snapshot, getQueueStats()), "info");
}
