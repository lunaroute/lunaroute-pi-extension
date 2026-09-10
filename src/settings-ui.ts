import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, SettingsList, Text, type SettingItem } from "@earendil-works/pi-tui";
import { LUNAROUTE_PROVIDER } from "./lunaroute.js";
import {
	disposeLunarouteMcp,
	isAlreadyRegisteredError,
	isLunarouteMcpConfigured,
	maybeShowAdapterHint,
	maybeShowConfiguredNotice,
	registerLunarouteMcp,
} from "./mcp.js";
import { readSettings, settingsPath, writeSettings, type LunarouteSettings } from "./settings.js";
import { getRegisteredImageToolNames, invalidateImageToolRegistrations, registerImageTools } from "./image-tools.js";
import { getRegisteredConvertToolNames, invalidateConvertToolRegistrations, registerConvertTools } from "./convert-tools.js";
import { getRegisteredWebToolNames, registerWebTools } from "./web-tools.js";

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
			description: "Hosted LunaRoute MCP server (generate_image, …) via pi-mcp-adapter",
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
	];
}

export type SettingChangeApplier = (id: string, newValue: string) => Promise<void>;

/** Create the write-then-live-apply handler for one settings change.
 *
 * Order matters: the file is the source of truth and is written first; the
 * in-process application (setActiveTools / MCP dispose / register) is an
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
		settings = { ...settings, [id]: newValue } as LunarouteSettings;
		try {
			write(deps.env, settings);
		} catch (err) {
			ui.notify(`Failed to save lunaroute.json: ${err instanceof Error ? err.message : String(err)}`, "error");
			return;
		}
		if (id === "searchProvider") return; // next web_search call reads it
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
			if (id === "mcp") await applyMcp(pi, deps, ui, getApiKey, newValue === "on");
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

async function applyMcp(
	pi: ExtensionAPI,
	deps: SettingsCommandDeps,
	ui: { notify: NotifyFn },
	getApiKey: () => Promise<string | undefined>,
	on: boolean,
): Promise<void> {
	if (!on) {
		await disposeLunarouteMcp();
		ui.notify("LunaRoute MCP disabled", "info");
		return;
	}
	// Mirror session_start: a user-configured LunaRoute MCP wins (the adapter
	// keeps the configured server and rejects ours by name).
	if (await isLunarouteMcpConfigured(deps.env)) {
		maybeShowConfiguredNotice(ui);
		return;
	}
	const key = await getApiKey();
	if (!key) {
		ui.notify("Not logged in — run /login lunaroute to enable MCP tools.", "info");
		return;
	}
	const { registered, error } = registerLunarouteMcp(pi, key, deps);
	if (error && isAlreadyRegisteredError(error)) {
		maybeShowConfiguredNotice(ui);
		return;
	}
	if (error) {
		ui.notify(`LunaRoute MCP registration failed: ${error.message}`, "warning");
		return;
	}
	if (!registered) {
		maybeShowAdapterHint(ui);
		return;
	}
	ui.notify("LunaRoute MCP enabled", "info");
}

/** Register the `/lunaroute` settings command. */
export function registerLunarouteSettingsCommand(pi: ExtensionAPI, deps: SettingsCommandDeps): void {
	pi.registerCommand("lunaroute", {
		description: "LunaRoute settings: MCP tools, web search, search provider",
		handler: async (_args, ctx) => {
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
		},
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
