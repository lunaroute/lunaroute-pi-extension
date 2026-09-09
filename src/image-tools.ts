import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ThemeColor, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type TSchema } from "typebox";
import { agentDirFromEnv, buildAttributionHeaders, resolveMcpUrl } from "./lunaroute.js";
import { createLunarouteMcpClient, type FetchLike, type LunarouteMcpClient } from "./web-tools.js";
import { DEFAULT_SETTINGS, imageToolsEnabled, type LunarouteSettings } from "./settings.js";

// First-class image tools (kata e30g): generate_image / edit_image /
// upload_image, backed by the hosted LunaRoute MCP server — the same pattern
// as the web tools (kata akyg), minus local presence detection: these names
// are LunaRoute-specific, and the server's tools/list already gates per-org
// entitlement/policy. Generated/edited images are saved to a
// per-installation folder so terminal users get the actual file.
//
// Server contract (verified 2026-09-09, lunaroute-hosted mcp.rs):
// - generate_image: prompt+model required; optional size/steps/guidance/
//   negative_prompt/seed/output_format; `embed: true` adds an inline
//   {"type":"image","data":<b64>,"mimeType":...} content part (dropped, with
//   a "too large to embed" note, over MCP_EMBED_MAX_BYTES — 8 MiB default).
// - edit_image: the same args + image_ids (img_… ids only).
// - upload_image: data (base64) XOR url; returns id + dims + MiB + url.
// - Results are LINE-BASED text (not JSON):
//     Generated|Edited into WxH fmt with model (seed N, M steps)
//     id: img_…
//     from: parent ids            (edits only)
//     url: … (link expires …)     (or "url: (temporarily unavailable — …)")
//     image expires: …
//     uploaded img_… (WxH fmt, N MiB)   (upload)

export const LUNAROUTE_ENV_IMAGE_DIR = "LUNAROUTE_IMAGE_DIR";
/** Mirrors the server's IMAGE_UPLOAD_MAX_BYTES default (11 MiB) — a
 * fail-fast guard before base64-inflating a file into JSON-RPC. The server
 * stays authoritative; deployments can configure it higher. */
export const UPLOAD_MAX_BYTES = 11 * 1024 * 1024;

// ============================================================================
// Result parsing (line-based server text → structured)
// ============================================================================

export interface ImageResult {
	verb: string;
	width: number;
	height: number;
	format: string;
	model: string;
	seed?: number;
	steps?: number;
	id: string;
	from?: string[];
	url?: string;
	urlExpires?: string;
	imageExpires?: string;
	/** Set when the text did not match the expected shape. */
	rawText?: string;
}

const UNAVAILABLE_URL = "url: (temporarily unavailable";

/** Parse the generate/edit result text. Tolerant: a parse failure keeps the
 * raw text so the model still sees what the server sent (web-tools
 * pattern). */
export function parseImageResultText(text: string): ImageResult {
	const lines = text.split("\n");
	const first = lines[0] ?? "";
	const head = /^(Generated|Edited into) (\d+)x(\d+) (\S+) with (.+)$/.exec(first);
	const idLine = lines.find((l) => l.startsWith("id: "));
	if (!head || !idLine) {
		return { verb: "", width: 0, height: 0, format: "", model: "", id: "", rawText: text };
	}
	let model = head[5];
	const detail = /\s*\(([^)]*)\)\s*$/.exec(model);
	let seed: number | undefined;
	let steps: number | undefined;
	if (detail) {
		model = model.slice(0, detail.index).trimEnd();
		const seedMatch = /seed (\d+)/.exec(detail[1]);
		const stepsMatch = /(\d+) steps/.exec(detail[1]);
		if (seedMatch) seed = Number(seedMatch[1]);
		if (stepsMatch) steps = Number(stepsMatch[1]);
	}
	const result: ImageResult = {
		verb: head[1],
		width: Number(head[2]),
		height: Number(head[3]),
		format: head[4] === "" ? "" : head[4],
		model,
		seed,
		steps,
		id: idLine.slice(4).trim(),
	};
	const fromLine = lines.find((l) => l.startsWith("from: "));
	if (fromLine) {
		result.from = fromLine
			.slice(6)
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
	}
	const urlLine = lines.find((l) => l.startsWith("url: "));
	if (urlLine && !urlLine.startsWith(UNAVAILABLE_URL)) {
		result.url = urlLine.slice(5).replace(/\s*\(link expires [^)]*\)\s*$/, "").trim();
		const expires = /\(link expires ([^)]*)\)/.exec(urlLine);
		if (expires) result.urlExpires = expires[1];
	}
	const imageExpires = lines.find((l) => l.startsWith("image expires: "));
	if (imageExpires) result.imageExpires = imageExpires.slice("image expires: ".length).trim();
	return result;
}

export interface UploadResult {
	id: string;
	width: number;
	height: number;
	format: string;
	mib: number;
	url?: string;
	urlExpires?: string;
	rawText?: string;
}

/** Parse the upload result text (`uploaded img_… (WxH fmt, N MiB)` + url). */
export function parseUploadResultText(text: string): UploadResult {
	const lines = text.split("\n");
	const head = /^uploaded (\S+) \((\d+)x(\d+) (\S+), ([0-9.]+) MiB\)$/.exec(lines[0] ?? "");
	if (!head) {
		return { id: "", width: 0, height: 0, format: "", mib: 0, rawText: text };
	}
	const result: UploadResult = {
		id: head[1],
		width: Number(head[2]),
		height: Number(head[3]),
		format: head[4],
		mib: Number(head[5]),
	};
	const urlLine = lines.find((l) => l.startsWith("url: "));
	if (urlLine && !urlLine.startsWith(UNAVAILABLE_URL)) {
		result.url = urlLine.slice(5).replace(/\s*\(link expires [^)]*\)\s*$/, "").trim();
		const expires = /\(link expires ([^)]*)\)/.exec(urlLine);
		if (expires) result.urlExpires = expires[1];
	}
	return result;
}

// ============================================================================
// Images dir (kata e30g: central, per pi installation)
// ============================================================================

/** Per-installation images folder: LUNAROUTE_IMAGE_DIR (absolute) wins, else
 * <agentDir>/lunaroute-images (same anchor as lunaroute.json — the
 * PI_CODING_AGENT_DIR → ~/.pi/agent resolution). */
export function resolveImageDir(env: NodeJS.ProcessEnv): string {
	const override = env[LUNAROUTE_ENV_IMAGE_DIR];
	if (typeof override === "string" && override) return override;
	return join(agentDirFromEnv(env), "lunaroute-images");
}

function extForFormat(format: string): string {
	if (format === "jpeg") return ".jpg";
	if (format === "png" || format === "webp") return `.${format}`;
	return ".png";
}

// ============================================================================
// Tool builders
// ============================================================================

export interface ImageToolDetails {
	id?: string;
	path?: string;
	url?: string;
	width?: number;
	height?: number;
	format?: string;
	model?: string;
	seed?: number;
	steps?: number;
	from?: string[];
	mib?: number;
	bytes?: number;
	error?: string;
}

export interface ImageIo {
	mkdir(path: string, options: { recursive: boolean }): Promise<void>;
	writeFile(path: string, data: Uint8Array): Promise<void>;
	stat(path: string): Promise<{ size: number }>;
	readFile(path: string): Promise<Uint8Array>;
}

const defaultIo: ImageIo = {
	// fs mkdir returns Promise<string | undefined>; the interface promises void.
	mkdir: async (path, options) => {
		await mkdir(path, options);
	},
	writeFile,
	stat,
	readFile,
};

type ThemeLike = {
	fg: (color: ThemeColor, text: string) => string;
	bold: (text: string) => string;
};

const truncateText = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n - 1) + "…");

/** Build the `model` parameter: the per-org enum + limit hints from the
 * server's tools/list when available, else a plain string. */
function modelParam(enumInfo: { enum: string[]; description?: string } | undefined) {
	if (enumInfo && enumInfo.enum.length > 0) {
		return Type.Union(enumInfo.enum.map((m) => Type.Literal(m)), {
			description: enumInfo.description ?? "Which image model to use.",
		});
	}
	return Type.String({ description: "Image model id, as offered by LunaRoute." });
}

async function fetchImageBytes(url: string, fetchImpl: FetchLike, signal?: AbortSignal): Promise<Uint8Array | undefined> {
	const res = await fetchImpl(url, { signal });
	if (!res.ok) return undefined;
	return Buffer.from(await res.arrayBuffer());
}

async function saveImage(
	dir: string,
	id: string,
	format: string,
	bytes: Uint8Array,
	io: ImageIo,
): Promise<string> {
	const path = join(dir, `${id}${extForFormat(format)}`);
	await io.mkdir(dir, { recursive: true });
	await io.writeFile(path, bytes);
	return path;
}

function textParts(call: { content?: { type: string; text?: string }[] }): string {
	return (call.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
}

function imagePart(call: { content?: { type: string; data?: string }[] }): { type: string; data?: string } | undefined {
	return (call.content ?? []).find((c) => c.type === "image" && typeof c.data === "string");
}

export interface ImageToolBuildDeps {
	client: LunarouteMcpClient;
	mcpToolName: string;
	env: NodeJS.ProcessEnv;
	fetchImpl?: FetchLike;
	io?: ImageIo;
	/** Per-org model enum + hints from tools/list (kata e30g enum baking). */
	modelEnum?: { enum: string[]; description?: string };
}

export function buildGenerateImageTool(deps: ImageToolBuildDeps) {
	const parameters = Type.Object({
		prompt: Type.String({ description: "What to generate" }),
		model: modelParam(deps.modelEnum),
		size: Type.Optional(Type.String({ description: "WIDTHxHEIGHT, e.g. 1024x1024. Defaults to the model's default size." })),
		steps: Type.Optional(Type.Number({ description: "Denoising steps. Defaults to the model's default; must be in the model's range." })),
		guidance: Type.Optional(Type.Number({ description: "Prompt adherence. Defaults to the model's default; must be in the model's range." })),
		negative_prompt: Type.Optional(Type.String({ description: "What to avoid. Only for models that support it." })),
		seed: Type.Optional(Type.Number({ minimum: 0, description: "Seed for a reproducible generation. Omit for a random one." })),
		output_format: Type.Optional(Type.String({ description: "One of the model's formats listed under model." })),
	});
	const tool: ToolDefinition<typeof parameters, ImageToolDetails> = {
		name: "generate_image",
		label: "Generate Image",
		description:
			"Generate an image from a text prompt via LunaRoute. Returns the image id, a time-limited URL, and the local path where the image was saved. Pass the id to edit_image to modify it later.",
		promptSnippet: "Generate images via LunaRoute",
		promptGuidelines: [
			"Use generate_image for image creation; report the saved local path to the user.",
			"To modify an image, pass its img_ id to edit_image (upload local files with upload_image first).",
		],
		parameters,
		async execute(_toolCallId, params, signal, onUpdate) {
			onUpdate?.({ content: [{ type: "text", text: "Generating image via LunaRoute…" }], details: {} });
			const call = await deps.client.callTool(
				deps.mcpToolName,
				{ ...params, embed: true },
				signal,
			);
			return await finishImageCall(call, deps, onUpdate);
		},
		renderCall(args, theme, context) {
			const label = theme.fg("toolTitle", theme.bold("generate_image"));
			let out = `${label} ${theme.fg("dim", truncateText(`"${args.prompt ?? ""}"`, 64))}`;
			if (typeof args.model === "string") out += theme.fg("dim", ` (${args.model})`);
			if (context.isPartial) out += `  ${theme.fg("warning", "⠸ generating…")}`;
			return new Text(out, 0, 0);
		},
		renderResult(result, options, theme) {
			return renderImageResult(result, options, theme);
		},
	};
	return tool;
}

export function buildEditImageTool(deps: ImageToolBuildDeps) {
	const parameters = Type.Object({
		prompt: Type.String({ description: "What to change" }),
		model: modelParam(deps.modelEnum),
		image_ids: Type.Array(Type.String(), { minItems: 1, description: "Prior LunaRoute image ids to edit (img_…)" }),
		size: Type.Optional(Type.String({ description: "WIDTHxHEIGHT for the result" })),
		steps: Type.Optional(Type.Number({ description: "Denoising steps" })),
		guidance: Type.Optional(Type.Number({ description: "Prompt adherence" })),
		negative_prompt: Type.Optional(Type.String({ description: "What to avoid (models that support it)" })),
		seed: Type.Optional(Type.Number({ minimum: 0, description: "Seed for a reproducible edit" })),
		output_format: Type.Optional(Type.String({ description: "One of the model's formats" })),
	});
	const tool: ToolDefinition<typeof parameters, ImageToolDetails> = {
		name: "edit_image",
		label: "Edit Image",
		description:
			"Edit prior images by their LunaRoute image id — the id returned by generate_image, a prior edit, or upload_image. Returns a new image id, URL, and the local path where it was saved.",
		promptSnippet: "Edit LunaRoute images by id",
		promptGuidelines: [
			"Use edit_image with img_ ids from generate_image/upload_image; pass uploaded files through upload_image first.",
		],
		parameters,
		async execute(_toolCallId, params, signal, onUpdate) {
			onUpdate?.({ content: [{ type: "text", text: "Editing image via LunaRoute…" }], details: {} });
			const call = await deps.client.callTool(
				deps.mcpToolName,
				{ ...params, embed: true },
				signal,
			);
			return await finishImageCall(call, deps, onUpdate);
		},
		renderCall(args, theme, context) {
			const label = theme.fg("toolTitle", theme.bold("edit_image"));
			const ids = Array.isArray(args.image_ids) ? args.image_ids.join(", ") : "";
			let out = `${label} ${theme.fg("dim", truncateText(`"${args.prompt ?? ""}" (${ids})`, 72))}`;
			if (context.isPartial) out += `  ${theme.fg("warning", "⠸ editing…")}`;
			return new Text(out, 0, 0);
		},
		renderResult(result, options, theme) {
			return renderImageResult(result, options, theme);
		},
	};
	return tool;
}

/** Shared tail for generate/edit execute: parse, save (inline bytes, else the
 * signed url), and shape the text + details. Never rewrites the server's own
 * lines — only appends the local-path line. */
async function finishImageCall(
	call: { content?: { type: string; text?: string; data?: string }[] },
	deps: ImageToolBuildDeps,
	onUpdate?: (update: { content: { type: "text"; text: string }[]; details: ImageToolDetails }) => void,
): Promise<{ content: { type: "text"; text: string }[]; details: ImageToolDetails }> {
	const text = textParts(call);
	const parsed = parseImageResultText(text);
	let bytes: Uint8Array | undefined;
	const inline = imagePart(call);
	if (inline?.data) bytes = Buffer.from(inline.data, "base64");
	else if (parsed.url) {
		onUpdate?.({ content: [{ type: "text", text: "Downloading the generated image…" }], details: {} });
		bytes = await fetchImageBytes(parsed.url, deps.fetchImpl ?? (fetch as FetchLike)).catch(() => undefined);
	}
	let path: string | undefined;
	if (bytes && parsed.id) {
		try {
			path = await saveImage(resolveImageDir(deps.env), parsed.id, parsed.format, bytes, deps.io ?? defaultIo);
		} catch {
			// Best-effort: the id + url still go out.
		}
	}
	const outText = `${text}\n${path ? `saved to: ${path}` : "not saved locally — fetch the url before it expires"}`;
	const details: ImageToolDetails = {
		id: parsed.id || undefined,
		path,
		url: parsed.url,
		width: parsed.width || undefined,
		height: parsed.height || undefined,
		format: parsed.format || undefined,
		model: parsed.model || undefined,
		seed: parsed.seed,
		steps: parsed.steps,
		from: parsed.from,
		bytes: bytes?.byteLength,
	};
	return { content: [{ type: "text", text: outText }], details };
}

function renderImageResult(
	result: { details?: unknown },
	options: { isPartial: boolean; expanded: boolean },
	theme: ThemeLike,
): Text {
	const details = (result.details ?? {}) as ImageToolDetails;
	if (options.isPartial) {
		return new Text(theme.fg("warning", "⠸ working…"), 0, 0);
	}
	if (details.error) {
		return new Text(theme.fg("error", `✗ ${details.error}`), 0, 0);
	}
	if (!options.expanded) {
		const dims = details.width && details.height ? `${details.width}x${details.height}` : "";
		let line = `${theme.fg("success", "✓")} ${theme.fg("muted", [details.id, dims, details.format].filter(Boolean).join(" · "))}`;
		if (details.mib !== undefined) line += theme.fg("muted", ` · ${details.mib} MiB`);
		line += theme.fg("muted", details.path ? " · saved" : details.id ? " · url only" : "");
		return new Text(line, 0, 0);
	}
	const lines = [
		details.path ? theme.fg("accent", details.path) : theme.fg("muted", "not saved locally"),
	];
	if (details.model) lines.push(theme.fg("dim", `model: ${details.model}`));
	if (details.seed !== undefined) lines.push(theme.fg("dim", `seed: ${details.seed}`));
	if (details.from?.length) lines.push(theme.fg("dim", `from: ${details.from.join(", ")}`));
	if (details.url) lines.push(theme.fg("dim", truncateText(details.url, 120)));
	return new Text(lines.join("\n"), 0, 0);
}

export function buildUploadImageTool(deps: ImageToolBuildDeps) {
	const parameters = Type.Object({
		path: Type.Optional(Type.String({ description: "Local path of the image file (png, jpeg, or webp). Exactly one of path or url." })),
		url: Type.Optional(Type.String({ description: "http(s) URL of the image to fetch server-side. Exactly one of path or url." })),
	});
	const tool: ToolDefinition<typeof parameters, ImageToolDetails> = {
		name: "upload_image",
		label: "Upload Image",
		description:
			"Upload an image you already have (a local file path, or an http(s) URL) to LunaRoute and get an img_… id. Pass that id to edit_image's image_ids to edit it.",
		promptSnippet: "Upload local images to LunaRoute for editing",
		promptGuidelines: [
			"Use upload_image to turn a local image file into an img_ id before edit_image.",
		],
		parameters,
		async execute(_toolCallId, params, signal, onUpdate) {
			const io = deps.io ?? defaultIo;
			let args: Record<string, unknown>;
			if (params.path && params.url) {
				throw new Error("exactly one of path or url is required, not both");
			} else if (params.path) {
				onUpdate?.({ content: [{ type: "text", text: `Reading ${params.path}…` }], details: {} });
				const info = await io.stat(params.path);
				if (info.size > UPLOAD_MAX_BYTES) {
					throw new Error(
						`${params.path} is ${(info.size / (1024 * 1024)).toFixed(1)} MiB — exceeds the ${(UPLOAD_MAX_BYTES / (1024 * 1024)) | 0} MiB LunaRoute upload ceiling`,
					);
				}
				const data = await io.readFile(params.path);
				args = { data: Buffer.from(data).toString("base64") };
			} else if (params.url) {
				args = { url: params.url };
			} else {
				throw new Error("exactly one of path or url is required");
			}
			onUpdate?.({ content: [{ type: "text", text: "Uploading image to LunaRoute…" }], details: {} });
			const call = await deps.client.callTool(deps.mcpToolName, args, signal);
			const text = textParts(call);
			const parsed = parseUploadResultText(text);
			const details: ImageToolDetails = {
				id: parsed.id || undefined,
				url: parsed.url,
				width: parsed.width || undefined,
				height: parsed.height || undefined,
				format: parsed.format || undefined,
				mib: parsed.mib || undefined,
			};
			const outText = `${text}\npass this id to edit_image's image_ids to edit it.`;
			return { content: [{ type: "text", text: outText }], details };
		},
		renderCall(args, theme, context) {
			const label = theme.fg("toolTitle", theme.bold("upload_image"));
			const what = args.path ?? args.url ?? "";
			let out = `${label} ${theme.fg("dim", truncateText(String(what), 72))}`;
			if (context.isPartial) out += `  ${theme.fg("warning", "⠸ uploading…")}`;
			return new Text(out, 0, 0);
		},
		renderResult(result, options, theme) {
			return renderImageResult(result, options, theme);
		},
	};
	return tool;
}

// ============================================================================
// Registration orchestrator
// ============================================================================

export type ImageToolOutcome = "registered" | "skipped-server" | "skipped-disabled" | "register-failed";

export interface ImageToolsRegistration {
	generateImage: ImageToolOutcome;
	editImage: ImageToolOutcome;
	uploadImage: ImageToolOutcome;
	error?: string;
}

export interface RegisterImageToolsDeps {
	key: string;
	env: NodeJS.ProcessEnv;
	version: string;
	sessionId: string;
	fetchImpl?: FetchLike;
	settings?: LunarouteSettings;
}

/** Extract the per-org `model` enum + hint description from a tools/list
 * inputSchema (the server bakes per-model limits into the description). */
export function extractModelEnum(inputSchema: unknown): { enum: string[]; description?: string } | undefined {
	if (typeof inputSchema !== "object" || inputSchema === null) return undefined;
	const properties = (inputSchema as { properties?: Record<string, unknown> }).properties;
	const model = properties?.model;
	if (typeof model !== "object" || model === null) return undefined;
	const { enum: values, description } = model as { enum?: unknown; description?: unknown };
	if (!Array.isArray(values) || values.length === 0) return undefined;
	if (!values.every((v): v is string => typeof v === "string")) return undefined;
	return {
		enum: values,
		description: typeof description === "string" ? description : undefined,
	};
}

// Tools this process registered: the settings UI's live-apply touches only
// these names (same rule as the web tools, kata bjy9).
const registeredImageToolNames = new Set<string>();

/** Names of the image tools this process registered (settings live-apply). */
export function getRegisteredImageToolNames(): ReadonlySet<string> {
	return registeredImageToolNames;
}

/** Test-only: reset module-scoped state. */
export function _resetImageToolsState(): void {
	registeredImageToolNames.clear();
}

/** Register first-class image tools when the hosted LunaRoute MCP server
 * offers them. No local presence detection (kata e30g decision): the names
 * are LunaRoute-specific; the server's tools/list gates entitlement/policy.
 * Never throws — image tools are optional, exactly like the web tools. */
export async function registerImageTools(
	pi: ExtensionAPI,
	deps: RegisterImageToolsDeps,
): Promise<ImageToolsRegistration> {
	const settings = deps.settings ?? DEFAULT_SETTINGS;
	if (!imageToolsEnabled(deps.env, settings)) {
		return { generateImage: "skipped-disabled", editImage: "skipped-disabled", uploadImage: "skipped-disabled" };
	}

	const client = createLunarouteMcpClient({
		url: resolveMcpUrl(deps.env),
		headers: {
			"LUNAROUTE-API-KEY": deps.key,
			...buildAttributionHeaders(deps.version, deps.sessionId),
		},
		fetchImpl: deps.fetchImpl ?? (fetch as FetchLike),
	});

	let descriptors: { name: string; inputSchema?: unknown }[];
	try {
		descriptors = await (client.listToolDescriptors?.() ??
			client.listTools().then((names) => names.map((name) => ({ name }))));
	} catch (err) {
		// Server unreachable / auth rejected: stay silent, try again on the
		// next session_start (reload, resume, fork all re-fire it).
		return {
			generateImage: "skipped-server",
			editImage: "skipped-server",
			uploadImage: "skipped-server",
			error: err instanceof Error ? err.message : String(err),
		};
	}

	const byName = new Map(descriptors.map((d) => [d.name, d]));
	const generateDescriptor = byName.get("generate_image");
	const editDescriptor = byName.get("edit_image");
	const uploadDescriptor = byName.get("upload_image");

	const registration: ImageToolsRegistration = {
		generateImage: "skipped-server",
		editImage: "skipped-server",
		uploadImage: "skipped-server",
	};

	// Idempotent per-tool registration (roborev job 1636): session_start
	// re-fires on resume/fork/reload, so an already-registered name is
	// re-activated, never re-registered (pi replaces same-extension tools on
	// re-register and other hosts may reject duplicates outright); each tool
	// registers independently, and one failure neither blocks the others nor
	// inflates the reported outcome.
	const ensureActive = (name: string): void => {
		// Tools registered after startup are refreshed immediately, but the
		// active set does not change on its own — merge ours in explicitly.
		const active = pi.getActiveTools();
		if (!active.includes(name)) {
			pi.setActiveTools([...new Set([...active, name])]);
		}
	};
	const offerings: [keyof Pick<ImageToolsRegistration, "generateImage" | "editImage" | "uploadImage">, string, () => unknown][] = [
		["generateImage", "generate_image", () =>
			buildGenerateImageTool({
				client,
				mcpToolName: "generate_image",
				env: deps.env,
				fetchImpl: deps.fetchImpl,
				modelEnum: extractModelEnum(generateDescriptor?.inputSchema),
			})],
		["editImage", "edit_image", () =>
			buildEditImageTool({
				client,
				mcpToolName: "edit_image",
				env: deps.env,
				fetchImpl: deps.fetchImpl,
				modelEnum: extractModelEnum(editDescriptor?.inputSchema),
			})],
		["uploadImage", "upload_image", () =>
			buildUploadImageTool({ client, mcpToolName: "upload_image", env: deps.env, fetchImpl: deps.fetchImpl })],
	];
	for (const [key, name, build] of offerings) {
		if (!byName.has(name)) continue;
		if (registeredImageToolNames.has(name)) {
			ensureActive(name);
			registration[key] = "registered";
			continue;
		}
		try {
			pi.registerTool(build() as never);
			registeredImageToolNames.add(name);
			ensureActive(name);
			registration[key] = "registered";
		} catch (err) {
			registration[key] = "register-failed";
			registration.error ??= err instanceof Error ? err.message : String(err);
		}
	}

	return registration;
}
