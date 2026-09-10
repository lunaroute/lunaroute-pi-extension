import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { agentDirFromEnv, buildAttributionHeaders, resolveMcpUrl } from "./lunaroute.js";
import {
	createLunarouteMcpClient,
	spillFullOutput,
	truncateForModel,
	type FetchLike,
	type LunarouteMcpClient,
} from "./web-tools.js";
import { fetchImageBytes, sniffImageMime, type ImageIo } from "./image-tools.js";
import { DEFAULT_SETTINGS, convertToolsEnabled, type LunarouteSettings } from "./settings.js";

// First-class convert_document tool (kata zpzt): documents (Word, PowerPoint,
// Excel, OpenDocument, RTF, EPUB, CSV, PDF; raster images always OCR'd) →
// Markdown via the hosted LunaRoute MCP server — the same pattern as the web
// (akyg) and image (e30g) tools, with those katas' review-loop lessons baked
// in from day one.
//
// Server contract (verified 2026-09-10, lunaroute-hosted mcp.rs):
// - convert_document: url XOR data (base64) + optional filename (format hint,
//   REQUIRED for CSV) + ocr (default false) + embed (default true).
// - Listed per-org iff policy allows — no catalog dependency.
// - embed:true → markdown inline, capped at min(MCP_DOC_MAX_OUTPUT_BYTES,
//   MCP_EMBED_MAX_BYTES); over it the server answers `output_too_large`
//   ("try embed: false").
// - embed:false → stored doc_<ULID> artifact + `url: <signed> (link expires
//   <ts>)` result (link_line), 7-day retention; rejects len >
//   MCP_DOC_MAX_OUTPUT_BYTES. With stock defaults both caps are 1 MiB, so the
//   fallback only succeeds on deployments that raise MCP_DOC_MAX_OUTPUT_BYTES
//   above the embed cap — recorded honestly in the kata.
// - needs_ocr: scanned PDF with ocr:false → error; the caller retries with
//   ocr:true (the model's decision — OCR is the costly path).
// - tool_error text is "<code>: <message>".

export const LUNAROUTE_ENV_DOCS_DIR = "LUNAROUTE_DOCS_DIR";
/** Mirrors the server's MCP_DOC_MAX_INPUT_BYTES default (10 MiB) — a
 * fail-fast guard before base64-inflating a file into JSON-RPC. The server
 * stays authoritative; deployments can configure it higher. */
export const CONVERT_MAX_INPUT_BYTES = 10 * 1024 * 1024;

// ============================================================================
// Pure helpers
// ============================================================================

export interface ArtifactLink {
	url: string;
	expiresAt?: string;
}

/** Parse the embed:false artifact result — the same link_line contract the
 * image tools consume: `url: <signed> (link expires <ts>)`. */
export function parseArtifactUrl(text: string): ArtifactLink | undefined {
	for (const line of text.split("\n")) {
		if (!line.startsWith("url: ")) continue;
		const raw = line.slice(5).trim();
		if (!raw || raw.startsWith("(temporarily unavailable")) return undefined;
		const expires = /\(link expires ([^)]*)\)/.exec(raw);
		return {
			url: raw.replace(/\s*\(link expires [^)]*\)\s*$/, "").trim(),
			expiresAt: expires?.[1],
		};
	}
	return undefined;
}

/** Per-installation documents folder: LUNAROUTE_DOCS_DIR (absolute) wins,
 * else <agentDir>/lunaroute-docs (same anchor as lunaroute.json). */
export function resolveDocsDir(env: NodeJS.ProcessEnv): string {
	const override = env[LUNAROUTE_ENV_DOCS_DIR];
	if (typeof override === "string" && override) return override;
	return join(agentDirFromEnv(env), "lunaroute-docs");
}

export type DocumentFormat =
	| { kind: "binary"; format: "zip" | "pdf" | "rtf" }
	| { kind: "binary"; format: "image"; mime: string }
	| { kind: "text" };

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

/** Local format guard (the upload_image exfiltration precedent, amended in
 * the zpzt brainstorm): binary formats are sniffed by magic — ZIP-family
 * (docx/pptx/xlsx/odt/epub), PDF, RTF, raster images — and text must be
 * valid UTF-8 (CSV et al. — no delimiter heuristic; claimed-CSV is an
 * agent-trust boundary every text-carrying tool shares). Unrecognized input
 * is rejected before any bytes leave the machine. */
export function sniffDocumentFormat(bytes: Uint8Array): DocumentFormat | undefined {
	if (bytes.length === 0) return undefined; // nothing to convert
	if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
		return { kind: "binary", format: "zip" };
	}
	if (bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d) {
		return { kind: "binary", format: "pdf" }; // %PDF-
	}
	if (bytes.length >= 5 && bytes[0] === 0x7b && bytes[1] === 0x5c && bytes[2] === 0x72 && bytes[3] === 0x74 && bytes[4] === 0x66) {
		return { kind: "binary", format: "rtf" }; // {\rtf
	}
	const imageMime = sniffImageMime(bytes);
	if (imageMime) {
		return { kind: "binary", format: "image", mime: imageMime };
	}
	try {
		utf8Decoder.decode(bytes);
		return { kind: "text" };
	} catch {
		return undefined; // not a recognized binary format, not UTF-8 → reject
	}
}

// ============================================================================
// Tool builder
// ============================================================================

import { defaultIo } from "./image-tools.js";

function textParts(call: { content?: { type: string; text?: string }[] }): string {
	return (call.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
}

export interface ConvertToolDetails {
	filename?: string;
	bytes?: number;
	ocr?: boolean;
	/** Docs-dir artifact path (the output_too_large fallback). */
	path?: string;
	artifactUrl?: string;
	fullOutputPath?: string;
	error?: string;
}

export interface ConvertToolBuildDeps {
	client: LunarouteMcpClient;
	mcpToolName: string;
	env: NodeJS.ProcessEnv;
	fetchImpl?: FetchLike;
	io?: ImageIo;
}

function buffersEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

function sanitizeBaseName(name: string): string {
	const stem = name.replace(/\.[^.]*$/, "").replace(/[^0-9A-Za-z._-]+/g, "_");
	return stem || "document";
}

/** Atomic, abort-aware document save (the full e30g review-loop discipline):
 * temp-then-rename, cancellation re-checks before and after every await, and
 * a unique suffix when a different file already occupies the target name —
 * identical content keeps the same path (idempotent re-conversion). */
async function saveDocument(
	dir: string,
	baseName: string,
	bytes: Uint8Array,
	io: ImageIo,
	signal?: AbortSignal,
): Promise<string | undefined> {
	if (signal?.aborted) return undefined;
	// Hoisted so the catch always removes the REAL temp file (roborev 1713).
	let finalTmp: string | undefined;
	try {
		await io.mkdir(dir, { recursive: true });
		if (signal?.aborted) return undefined;
		const target = join(dir, `${baseName}.md`);
		const existing = await io.readFileBounded(target, bytes.byteLength + 1).catch(() => undefined);
		const preExisting = existing !== undefined && buffersEqual(existing, bytes);
		const finalPath = existing && !buffersEqual(existing, bytes) ? join(dir, `${baseName}-${randomUUID().slice(0, 6)}.md`) : target;
		finalTmp = `${finalPath}.${randomUUID()}.tmp`;
		await io.writeFile(finalTmp, bytes);
		if (signal?.aborted) {
			await io.rm(finalTmp).catch(() => {});
			return undefined;
		}
		await io.rename(finalTmp, finalPath);
		if (signal?.aborted) {
			// Post-rename cancellation only removes what WE introduced: a
			// pre-existing identical document is the user's file, not ours,
			// and shared <basename>.md names are not unique like img_ ids
			// (roborev 1713 — the e30g image rule does not carry over).
			if (!preExisting) {
				await io.rm(finalPath).catch(() => {});
			}
			return undefined;
		}
		return finalPath;
	} catch {
		if (finalTmp !== undefined) {
			await io.rm(finalTmp).catch(() => {});
		}
		return undefined;
	}
}

export function buildConvertTool(deps: ConvertToolBuildDeps) {
	const parameters = Type.Object({
		path: Type.Optional(
			Type.String({
				description:
					"Local path of the document (Word, PowerPoint, Excel, OpenDocument, RTF, EPUB, CSV, PDF; raster images are OCR'd). Exactly one of path or url.",
			}),
		),
		url: Type.Optional(
			Type.String({ description: "http(s) URL of the document to convert. Exactly one of path or url." }),
		),
		filename: Type.Optional(
			Type.String({ description: "Format hint like report.csv; required for CSV. Derived from the local path when omitted; set it explicitly for URLs." }),
		),
		ocr: Type.Optional(
			Type.Boolean({
				description:
					"OCR scanned PDF pages via the configured backend (the costly path). Default false: scanned pages answer needs_ocr — retry with ocr: true.",
			}),
		),
	});
	const tool: ToolDefinition<typeof parameters, ConvertToolDetails> = {
		name: "convert_document",
		label: "Convert Document",
		description:
			"Convert a document (Word, PowerPoint, Excel, OpenDocument, RTF, EPUB, CSV, PDF) or a raster image into Markdown via LunaRoute. " +
			"Returns the Markdown inline; oversized documents are stored as artifacts and saved to the local documents folder, with the path returned.",
		promptSnippet: "Convert documents to Markdown via LunaRoute",
		promptGuidelines: [
			"Use convert_document to read docx/pdf/xlsx/etc. files as Markdown; retry with ocr: true when the result says needs_ocr.",
		],
		parameters,
		async execute(_toolCallId, params, signal, onUpdate) {
			const io = deps.io ?? defaultIo;
			let args: Record<string, unknown>;
			let filename: string | undefined = params.filename;
			if (params.path && params.url) {
				throw new Error("exactly one of path or url is required, not both");
			} else if (params.path) {
				onUpdate?.({ content: [{ type: "text", text: `Reading ${params.path}…` }], details: {} });
				const data = await io.readFileBounded(params.path, CONVERT_MAX_INPUT_BYTES + 1);
				if (data.byteLength > CONVERT_MAX_INPUT_BYTES) {
					throw new Error(
						`${params.path} exceeds the ${(CONVERT_MAX_INPUT_BYTES / (1024 * 1024)) | 0} MiB LunaRoute conversion ceiling`,
					);
				}
				const format = sniffDocumentFormat(data);
				if (!format) {
					throw new Error(
						`${params.path} is not a recognized document (docx/pptx/xlsx/odt/epub/pdf/rtf/csv/image) — refusing to upload it`,
					);
				}
				filename ??= basename(params.path);
				args = {
					data: Buffer.from(data).toString("base64"),
					filename,
					...(params.ocr !== undefined && { ocr: params.ocr }),
				};
			} else if (params.url) {
				let parsed: URL;
				try {
					parsed = new URL(params.url);
				} catch {
					throw new Error(`"${params.url}" is not a valid URL`);
				}
				if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
					throw new Error(`convert_document urls must be http(s), got ${parsed.protocol}//`);
				}
				args = { url: params.url, ...(filename !== undefined && { filename }), ...(params.ocr !== undefined && { ocr: params.ocr }) };
			} else {
				throw new Error("exactly one of path or url is required");
			}

			onUpdate?.({ content: [{ type: "text", text: "Converting document via LunaRoute…" }], details: {} });
			// Both error shapes route output_too_large to the fallback: our own
			// client THROWS on isError, but a host-provided client may hand the
			// raw result back (the e30g/roborev-1694 lesson). The fallback itself
			// runs OUTSIDE this try — its own errors must never re-enter the
			// catch and trigger a duplicate fallback conversion (roborev 1713).
			let call: { content?: { type: string; text?: string }[]; isError?: boolean };
			let fallbackError: string | undefined;
			try {
				call = await deps.client.callTool(deps.mcpToolName, { ...args, embed: true }, signal);
				if (call.isError) {
					const message = textParts(call);
					if (/output_too_large/.test(message)) {
						fallbackError = message;
					} else {
						throw new Error(message || `MCP tool ${deps.mcpToolName} returned an error`);
					}
				}
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				if (!/output_too_large/.test(message)) throw err;
				fallbackError = message;
			}
			if (fallbackError !== undefined) {
				return await convertFallback(args, filename, deps, io, signal, onUpdate, fallbackError);
			}
			// Every non-fallback path assigned `call` above (success in the
			// try; errors threw or set fallbackError).
			const markdown = textParts(call!);
			const { text, truncated } = truncateForModel(markdown);
			let fullOutputPath: string | undefined;
			if (truncated) {
				try {
					fullOutputPath = await spillFullOutput(markdown, undefined, { prefix: "lunaroute-doc", ext: "md" });
				} catch {
					// Best-effort; the truncated text still goes out.
				}
			}
			const out = truncated
				? `${text}\n\n[Output truncated. Full markdown saved to: ${fullOutputPath ?? "temp file unavailable"}]`
				: markdown;
			return {
				content: [{ type: "text" as const, text: out }],
				details: { filename, bytes: Buffer.byteLength(markdown, "utf8"), ocr: params.ocr, fullOutputPath },
			};
		},
		renderCall(args, theme, context) {
			const label = theme.fg("toolTitle", theme.bold("convert_document"));
			const what = args.path ?? args.url ?? "";
			let out = `${label} ${theme.fg("dim", what.length > 72 ? `${what.slice(0, 71)}…` : what)}`;
			if (context.isPartial) out += `  ${theme.fg("warning", "⠸ converting…")}`;
			return new Text(out, 0, 0);
		},
		renderResult(result, options, theme) {
			const details = (result.details ?? {}) as ConvertToolDetails;
			if (options.isPartial) {
				return new Text(theme.fg("warning", "⠸ converting…"), 0, 0);
			}
			if (details.error) {
				return new Text(theme.fg("error", `✗ ${details.error}`), 0, 0);
			}
			const kb = details.bytes ? ` · ${(details.bytes / 1024).toFixed(1)} KB` : "";
			if (!options.expanded) {
				let line = `${theme.fg("success", "✓")} ${theme.fg("muted", `converted ${details.filename ?? "document"}${kb}`)}`;
				if (details.path) line += theme.fg("muted", " · saved");
				return new Text(line, 0, 0);
			}
			const lines = [details.path ? theme.fg("accent", details.path) : theme.fg("muted", "returned inline")];
			if (details.fullOutputPath) lines.push(theme.fg("muted", `full markdown: ${details.fullOutputPath}`));
			if (details.artifactUrl) lines.push(theme.fg("dim", details.artifactUrl));
			if (details.ocr !== undefined) lines.push(theme.fg("dim", `ocr: ${details.ocr}`));
			return new Text(lines.join("\n"), 0, 0);
		},
	};
	return tool;
}

/** The output_too_large fallback: retry with embed:false, download the
 * artifact, save it to the docs dir. With stock server defaults both caps
 * are 1 MiB so the retry may fail the same way — that error is surfaced
 * honestly. The retry re-runs the whole conversion (no store-previous
 * result API server-side). */
async function convertFallback(
	args: Record<string, unknown>,
	filename: string | undefined,
	deps: ConvertToolBuildDeps,
	io: ImageIo,
	signal: AbortSignal | undefined,
	onUpdate: ((update: { content: { type: "text"; text: string }[]; details: ConvertToolDetails }) => void) | undefined,
	originalError: string,
): Promise<{ content: { type: "text"; text: string }[]; details: ConvertToolDetails }> {
	onUpdate?.({ content: [{ type: "text", text: "Output too large — storing as an artifact…" }], details: {} });
	const call = await deps.client.callTool(deps.mcpToolName, { ...args, embed: false }, signal);
	if (call.isError) {
		throw new Error(textParts(call) || `MCP tool ${deps.mcpToolName} returned an error`);
	}
	const text = textParts(call);
	const link = parseArtifactUrl(text);
	const artifactNote = link ? text : `output_too_large fallback did not return an artifact url — ${originalError}`;
	if (!link) {
		return { content: [{ type: "text", text: artifactNote }], details: { filename } };
	}
	const bytes = await fetchImageBytes(link.url, deps.fetchImpl ?? (fetch as FetchLike), signal).catch(() => undefined);
	if (!bytes) {
		return {
			content: [{ type: "text", text: `${text}\n(the artifact could not be downloaded locally — fetch the url before it expires)` }],
			details: { filename, artifactUrl: link.url },
		};
	}
	const baseName = sanitizeBaseName(filename ?? "document");
	const path = await saveDocument(resolveDocsDir(deps.env), baseName, bytes, io, signal);
	if (!path) {
		return {
			content: [{ type: "text", text: `${text}\n(the document could not be saved locally — fetch the url before it expires)` }],
			details: { filename, artifactUrl: link.url, bytes: bytes.byteLength },
		};
	}
	const head = Buffer.from(bytes).toString("utf8").slice(0, 1500);
	return {
		content: [
			{
				type: "text",
				text: `full document saved to: ${path}\n(link expires ${link.expiresAt ?? "soon"})\n\n${head}${head.length >= 1500 ? "\n…" : ""}`,
			},
		],
		details: { filename, path, artifactUrl: link.url, bytes: bytes.byteLength },
	};
}

// ============================================================================
// Registration orchestrator (every e30g review-loop lesson, day one)
// ============================================================================

import { delegatingClient } from "./image-tools.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const registeredConvertToolNames = new Set<string>();
// The one client the registered convert tool talks through; swapped on every
// re-entry so a rotated key (re-login) reaches it without re-registration.
const currentConvertClient: { client?: LunarouteMcpClient } = {};
let convertRegistrationGeneration = 0;

export function getRegisteredConvertToolNames(): ReadonlySet<string> {
	return registeredConvertToolNames;
}

/** Test-only: reset module-scoped state. */
export function _resetConvertToolsState(): void {
	registeredConvertToolNames.clear();
	currentConvertClient.client = undefined;
	convertRegistrationGeneration = 0;
}

/** Invalidate any in-flight convert registration (the user just disabled the
 * tools) — a catalog fetch resolving later must not register anything. */
export function invalidateConvertToolRegistrations(): void {
	convertRegistrationGeneration++;
}

export type ConvertToolOutcome = "registered" | "skipped-existing" | "skipped-server" | "skipped-disabled" | "register-failed";

export interface ConvertToolsRegistration {
	convert: ConvertToolOutcome;
	error?: string;
}

export interface RegisterConvertToolsDeps {
	key: string;
	env: NodeJS.ProcessEnv;
	version: string;
	sessionId: string;
	fetchImpl?: FetchLike;
	settings?: LunarouteSettings;
}

/** Register the first-class convert_document tool when the hosted LunaRoute
 * MCP server offers it. No local presence detection (the name is
 * LunaRoute-specific); the server's tools/list gates policy. Never throws. */
export async function registerConvertTools(
	pi: ExtensionAPI,
	deps: RegisterConvertToolsDeps,
): Promise<ConvertToolsRegistration> {
	const settings = deps.settings ?? DEFAULT_SETTINGS;
	if (!convertToolsEnabled(deps.env, settings)) {
		// A disable supersedes any in-flight registration.
		convertRegistrationGeneration++;
		return { convert: "skipped-disabled" };
	}

	const client = createLunarouteMcpClient({
		url: resolveMcpUrl(deps.env),
		headers: {
			"LUNAROUTE-API-KEY": deps.key,
			...buildAttributionHeaders(deps.version, deps.sessionId),
		},
		fetchImpl: deps.fetchImpl ?? (fetch as FetchLike),
	});
	// Swap the shared client BEFORE catalog discovery: after a key rotation,
	// the fresh client is strictly better even when the catalog fetch fails.
	const generation = ++convertRegistrationGeneration;
	currentConvertClient.client = client;
	const stableClient = delegatingClient(currentConvertClient);

	let descriptors: { name: string; inputSchema?: unknown }[];
	try {
		descriptors = await (client.listToolDescriptors?.() ?? client.listTools().then((names) => names.map((name) => ({ name }))));
	} catch (err) {
		return { convert: "skipped-server", error: err instanceof Error ? err.message : String(err) };
	}
	if (generation !== convertRegistrationGeneration) {
		return { convert: "skipped-server", error: "superseded by a newer registration" };
	}

	const byName = new Map(descriptors.map((d) => [d.name, d]));
	// Catalog drift: a tool the server no longer offers is deactivated —
	// ownership kept (pi has no unregister), a later re-offer re-activates.
	for (const name of [...registeredConvertToolNames]) {
		if (!byName.has(name)) {
			pi.setActiveTools(pi.getActiveTools().filter((n) => n !== name));
		}
	}

	if (!byName.has("convert_document")) {
		return { convert: "skipped-server" };
	}
	// Ownership pre-check: cross-extension names are first-registration-wins;
	// a foreign convert_document means we stay silent — never register, never
	// track, never touch its active state.
	if (!registeredConvertToolNames.has("convert_document") && pi.getAllTools().some((t) => t.name === "convert_document")) {
		return { convert: "skipped-existing" };
	}
	const ensureActive = (): void => {
		const active = pi.getActiveTools();
		if (!active.includes("convert_document")) {
			pi.setActiveTools([...new Set([...active, "convert_document"])]);
		}
	};
	if (registeredConvertToolNames.has("convert_document")) {
		ensureActive();
		return { convert: "registered" };
	}
	try {
		pi.registerTool(
			buildConvertTool({
				client: stableClient,
				mcpToolName: "convert_document",
				env: deps.env,
				fetchImpl: deps.fetchImpl,
			}),
		);
		registeredConvertToolNames.add("convert_document");
		ensureActive();
		return { convert: "registered" };
	} catch (err) {
		return { convert: "register-failed", error: err instanceof Error ? err.message : String(err) };
	}
}
