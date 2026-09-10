import { beforeEach, describe, expect, test, vi } from "vitest";
import {
	CONVERT_MAX_INPUT_BYTES,
	parseArtifactUrl,
	resolveDocsDir,
	sniffDocumentFormat,
} from "../src/convert-tools.js";

describe("parseArtifactUrl (link_line server contract)", () => {
	test("parses url + expiry from the link_line text", () => {
		const link = parseArtifactUrl("url: https://storage.example.com/docs/doc_01X?sig=abc (link expires 2026-09-17T00:00:00Z)");
		expect(link).toEqual({
			url: "https://storage.example.com/docs/doc_01X?sig=abc",
			expiresAt: "2026-09-17T00:00:00Z",
		});
	});

	test("missing expiry still yields the url", () => {
		const link = parseArtifactUrl("url: https://storage.example.com/docs/doc_01X?sig=abc");
		expect(link?.url).toBe("https://storage.example.com/docs/doc_01X?sig=abc");
		expect(link?.expiresAt).toBeUndefined();
	});

	test("non-matching text yields undefined", () => {
		expect(parseArtifactUrl("# some markdown")).toBeUndefined();
		expect(parseArtifactUrl("")).toBeUndefined();
	});
});

describe("resolveDocsDir (kata zpzt: per-installation central folder)", () => {
	test("default: <agentDir>/lunaroute-docs", () => {
		expect(resolveDocsDir({ PI_CODING_AGENT_DIR: "/tmp/agent" })).toBe("/tmp/agent/lunaroute-docs");
	});

	test("LUNAROUTE_DOCS_DIR (absolute) wins over the agent dir", () => {
		expect(resolveDocsDir({ PI_CODING_AGENT_DIR: "/tmp/agent", LUNAROUTE_DOCS_DIR: "/data/docs" })).toBe("/data/docs");
	});
});

describe("sniffDocumentFormat (local format guard)", () => {
	const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]); // docx/pptx/xlsx/odt/epub
	const PDF = Buffer.from("%PDF-1.7\n...", "utf8");
	const RTF = Buffer.from("{\\rtf1\\ansi}", "utf8");
	const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);

	test("accepts the binary document magics", () => {
		expect(sniffDocumentFormat(ZIP)).toEqual({ kind: "binary", format: "zip" });
		expect(sniffDocumentFormat(PDF)).toEqual({ kind: "binary", format: "pdf" });
		expect(sniffDocumentFormat(RTF)).toEqual({ kind: "binary", format: "rtf" });
	});

	test("accepts raster images (always OCR'd server-side)", () => {
		expect(sniffDocumentFormat(PNG)).toEqual({ kind: "binary", format: "image", mime: "image/png" });
	});

	test("accepts UTF-8 text (csv et al.) as text", () => {
		expect(sniffDocumentFormat(Buffer.from("a,b,c\n1,2,3\n", "utf8"))).toEqual({ kind: "text" });
		expect(sniffDocumentFormat(Buffer.from("just a plain sentence", "utf8"))).toEqual({ kind: "text" });
	});

	test("rejects unrecognized binary before any bytes leave the machine", () => {
		expect(sniffDocumentFormat(Buffer.from([0x00, 0x01, 0x02, 0x03, 0xfe, 0xfd]))).toBeUndefined();
		expect(sniffDocumentFormat(new Uint8Array(0))).toBeUndefined();
	});

	test("rejects invalid UTF-8 (e.g. UTF-16 content)", () => {
		expect(sniffDocumentFormat(Buffer.from([0xff, 0xfe, 0x61, 0x00, 0x62, 0x00]))).toBeUndefined();
	});
});

describe("input cap", () => {
	test("matches the server's MCP_DOC_MAX_INPUT_BYTES default (10 MiB)", () => {
		expect(CONVERT_MAX_INPUT_BYTES).toBe(10 * 1024 * 1024);
	});
});

// ============================================================================
// Wave 3: tool builder
// ============================================================================

import { buildConvertTool, type ConvertToolDetails } from "../src/convert-tools.js";
import type { ImageIo } from "../src/image-tools.js";

const AC = () => new AbortController().signal;

function memoryIo(): ImageIo & { files: Map<string, Uint8Array> } {
	const files = new Map<string, Uint8Array>();
	return {
		files,
		mkdir: async () => {},
		writeFile: async (path, data) => {
			files.set(path, data);
		},
		rename: async (from, to) => {
			if (files.has(from)) {
				files.set(to, files.get(from)!);
				files.delete(from);
			}
		},
		rm: async (path) => {
			files.delete(path);
		},
		readFileBounded: async (path, maxBytes) => {
			// Match real fs semantics: a missing file THROWS (ENOENT), the
			// collision check distinguishes existing files from absent ones.
			const bytes = files.get(path);
			if (!bytes) throw new Error(`ENOENT: ${path}`);
			return bytes.subarray(0, maxBytes);
		},
	};
}

function fakeClient(parts: { type: string; text?: string }[], isError = false) {
	return {
		listTools: vi.fn(async () => [] as string[]),
		callTool: vi.fn(async () => ({ content: parts, isError })),
	};
}

const MARKDOWN = "# Report\n\nsome converted markdown\n";

describe("buildConvertTool execute", () => {
	const DOCX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64, 7)]);

	test("path: bounded read, format guard passes, sends data + derived filename, embed: true", async () => {
		const client = fakeClient([{ type: "text", text: MARKDOWN }]);
		const io = memoryIo();
		io.files.set("/home/u/report.docx", DOCX);
		const tool = buildConvertTool({ client, mcpToolName: "convert_document", env: {}, io });
		const result = await tool.execute("t1", { path: "/home/u/report.docx" } as never, AC(), undefined, {} as never);
		expect(client.callTool).toHaveBeenCalledWith(
			"convert_document",
			{ data: DOCX.toString("base64"), filename: "report.docx", embed: true },
			expect.anything(),
		);
		expect((result.content[0] as { text?: string }).text).toBe(MARKDOWN);
		expect(result.details).toMatchObject({ filename: "report.docx", bytes: MARKDOWN.length });
	});

	test("path + explicit filename + ocr passthrough", async () => {
		const client = fakeClient([{ type: "text", text: MARKDOWN }]);
		const io = memoryIo();
		io.files.set("/home/u/download", Buffer.from("a,b\n1,2\n", "utf8")); // text/CSV
		const tool = buildConvertTool({ client, mcpToolName: "convert_document", env: {}, io });
		await tool.execute("t1", { path: "/home/u/download", filename: "report.csv", ocr: true } as never, AC(), undefined, {} as never);
		expect(client.callTool).toHaveBeenCalledWith(
			"convert_document",
			{ data: Buffer.from("a,b\n1,2\n").toString("base64"), filename: "report.csv", ocr: true, embed: true },
			expect.anything(),
		);
	});

	test("oversize file fails fast before the MCP call", async () => {
		const client = fakeClient([{ type: "text", text: MARKDOWN }]);
		const io = memoryIo();
		io.files.set("/home/u/huge.docx", Buffer.concat([DOCX, Buffer.alloc(CONVERT_MAX_INPUT_BYTES)]));
		const tool = buildConvertTool({ client, mcpToolName: "convert_document", env: {}, io });
		await expect(tool.execute("t1", { path: "/home/u/huge.docx" } as never, AC(), undefined, {} as never)).rejects.toThrow(/10 MiB/);
		expect(client.callTool).not.toHaveBeenCalled();
	});

	test("unrecognized binary is rejected locally (exfiltration guard)", async () => {
		const client = fakeClient([{ type: "text", text: MARKDOWN }]);
		const io = memoryIo();
		io.files.set("/home/u/.aws/credentials", Buffer.from([0x00, 0x01, 0x02, 0x80]));
		const tool = buildConvertTool({ client, mcpToolName: "convert_document", env: {}, io });
		await expect(tool.execute("t1", { path: "/home/u/.aws/credentials" } as never, AC(), undefined, {} as never)).rejects.toThrow(/not a recognized document/i);
		expect(client.callTool).not.toHaveBeenCalled();
	});

	test("url: http(s) validated locally and passed through", async () => {
		const client = fakeClient([{ type: "text", text: MARKDOWN }]);
		const tool = buildConvertTool({ client, mcpToolName: "convert_document", env: {}, io: memoryIo() });
		await tool.execute("t1", { url: "https://example.com/report.pdf" } as never, AC(), undefined, {} as never);
		expect(client.callTool).toHaveBeenCalledWith("convert_document", { url: "https://example.com/report.pdf", embed: true }, expect.anything());
		await expect(tool.execute("t1", { url: "file:///etc/passwd" } as never, AC(), undefined, {} as never)).rejects.toThrow(/http\(s\)/i);
		expect(client.callTool).toHaveBeenCalledTimes(1);
	});

	test("both or neither of path/url → rejected locally", async () => {
		const tool = buildConvertTool({ client: fakeClient([]), mcpToolName: "convert_document", env: {}, io: memoryIo() });
		await expect(tool.execute("t1", {} as never, AC(), undefined, {} as never)).rejects.toThrow(/exactly one of path or url/i);
		await expect(tool.execute("t1", { path: "/a", url: "https://b" } as never, AC(), undefined, {} as never)).rejects.toThrow(/exactly one of path or url/i);
	});

	test("isError result fails the tool with the server text", async () => {
		const client = fakeClient([{ type: "text", text: "needs_ocr: pages 2-5 are scanned" }], true);
		const tool = buildConvertTool({ client, mcpToolName: "convert_document", env: {}, io: memoryIo() });
		await expect(tool.execute("t1", { url: "https://example.com/scan.pdf" } as never, AC(), undefined, {} as never)).rejects.toThrow(/needs_ocr/);
	});

	test("output_too_large triggers the embed:false fallback: artifact downloaded, saved, path + head returned", async () => {
		const calls: { embed: boolean }[] = [];
		const client = {
			listTools: vi.fn(async () => [] as string[]),
			callTool: vi.fn(async (_name: string, args: Record<string, unknown>) => {
				calls.push({ embed: args.embed as boolean });
				if (args.embed) {
					return { content: [{ type: "text", text: "output_too_large: document output is 2000000 bytes; inline cap is 1048576; try embed: false" }], isError: true };
				}
				return {
					content: [{ type: "text", text: "url: https://storage.example.com/docs/doc_01X?sig=abc (link expires 2026-09-17T00:00:00Z)" }],
					isError: false,
				};
			}),
		};
		const io = memoryIo();
		io.files.set("/home/u/report.docx", Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64)]));
		const fetchImpl = vi.fn(async () => new Response("# Big Report\n\nlots of markdown\n", { status: 200 }));
		vi.stubEnv("PI_CODING_AGENT_DIR", "/tmp/agent");
		const tool = buildConvertTool({ client, mcpToolName: "convert_document", env: process.env, io, fetchImpl });
		const result = await tool.execute("t1", { path: "/home/u/report.docx" } as never, AC(), undefined, {} as never);
		expect(calls.map((c) => c.embed)).toEqual([true, false]);
		const savedPath = "/tmp/agent/lunaroute-docs/report.md";
		expect(io.files.get(savedPath)).toEqual(Buffer.from("# Big Report\n\nlots of markdown\n"));
		const text = (result.content[0] as { text?: string }).text;
		expect(text).toContain("saved to:");
		expect(text).toContain(savedPath);
		expect(text).toContain("# Big Report");
		expect(result.details).toMatchObject({ path: savedPath, artifactUrl: "https://storage.example.com/docs/doc_01X?sig=abc", filename: "report.docx" });
	});

	test("double failure (both embed paths) surfaces the second error honestly", async () => {
		const client = {
			listTools: vi.fn(async () => [] as string[]),
			callTool: vi.fn(async () => ({
				content: [{ type: "text", text: "output_too_large: document output exceeds MCP_DOC_MAX_OUTPUT_BYTES" }],
				isError: true,
			})),
		};
		const io = memoryIo();
		io.files.set("/home/u/report.docx", Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(16)]));
		const tool = buildConvertTool({ client, mcpToolName: "convert_document", env: {}, io });
		await expect(tool.execute("t1", { path: "/home/u/report.docx" } as never, AC(), undefined, {} as never)).rejects.toThrow(/output_too_large/);
	});

	test("fallback with an undownloadable artifact still surfaces the URL", async () => {
		const client = {
			listTools: vi.fn(async () => [] as string[]),
			callTool: vi.fn(async (_name: string, args: Record<string, unknown>) => {
				if (args.embed) {
					return { content: [{ type: "text", text: "output_too_large: try embed: false" }], isError: true };
				}
				return { content: [{ type: "text", text: "url: https://storage.example.com/docs/doc_01X?sig=abc (link expires 2026-09-17T00:00:00Z)" }], isError: false };
			}),
		};
		const io = memoryIo();
		const fetchImpl = vi.fn(async () => new Response("nope", { status: 503 }));
		const tool = buildConvertTool({ client, mcpToolName: "convert_document", env: {}, io, fetchImpl });
		io.files.set("/home/u/report.docx", Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(16)]));
		const result = await tool.execute("t1", { path: "/home/u/report.docx" } as never, AC(), undefined, {} as never);
		const text = (result.content[0] as { text?: string }).text;
		expect(text).toContain("https://storage.example.com/docs/doc_01X");
		expect(text).not.toContain("saved to:");
		expect(io.files.size).toBe(1); // only the input file, nothing saved
	});

	test("oversized inline markdown is truncated and spilled as .md", async () => {
		const big = `# Big\n\n${"word ".repeat(20_000)}`;
		const client = fakeClient([{ type: "text", text: big }]);
		const tool = buildConvertTool({ client, mcpToolName: "convert_document", env: {}, io: memoryIo() });
		const result = await tool.execute("t1", { url: "https://example.com/big.docx" } as never, AC(), undefined, {} as never);
		const text = (result.content[0] as { text?: string }).text;
		expect(text).toContain("[Output truncated. Full markdown saved to:");
		expect(result.details?.fullOutputPath).toMatch(/lunaroute-doc-.*\.md$/);
	});

	test("same-name artifact with different content gets a unique suffix; same content keeps the path", async () => {
		const makeClient = (markdown: string) => ({
			listTools: vi.fn(async () => [] as string[]),
			callTool: vi.fn(async (_name: string, args: Record<string, unknown>) => {
				if (args.embed) {
					return { content: [{ type: "text", text: "output_too_large: try embed: false" }], isError: true };
				}
				return { content: [{ type: "text", text: "url: https://storage.example.com/docs/doc_01X?sig=abc (link expires 2026-09-17T00:00:00Z)" }], isError: false };
			}),
		});
		const io = memoryIo();
		io.files.set("/home/u/report.docx", Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(16)]));
		vi.stubEnv("PI_CODING_AGENT_DIR", "/tmp/agent");
		const fetchA = vi.fn(async () => new Response("content A", { status: 200 }));
		const first = await buildConvertTool({ client: makeClient("A"), mcpToolName: "convert_document", env: process.env, io, fetchImpl: fetchA })
			.execute("t1", { path: "/home/u/report.docx" } as never, AC(), undefined, {} as never);
		const fetchB = vi.fn(async () => new Response("different content B", { status: 200 }));
		const second = await buildConvertTool({ client: makeClient("B"), mcpToolName: "convert_document", env: process.env, io, fetchImpl: fetchB })
			.execute("t1", { path: "/home/u/report.docx" } as never, AC(), undefined, {} as never);
		const firstPath = (first.details as ConvertToolDetails).path;
		const secondPath = (second.details as ConvertToolDetails).path;
		expect(firstPath).toBe("/tmp/agent/lunaroute-docs/report.md");
		expect(secondPath).toMatch(/\/tmp\/agent\/lunaroute-docs\/report-[0-9a-f]{6}\.md$/);
		expect(secondPath).not.toBe(firstPath);
		const fetchC = vi.fn(async () => new Response("content A", { status: 200 }));
		const third = await buildConvertTool({ client: makeClient("A"), mcpToolName: "convert_document", env: process.env, io, fetchImpl: fetchC })
			.execute("t1", { path: "/home/u/report.docx" } as never, AC(), undefined, {} as never);
		expect((third.details as ConvertToolDetails).path).toBe(firstPath); // same content → same path
	});

	test("an aborted signal prevents the artifact save", async () => {
		const client = {
			listTools: vi.fn(async () => [] as string[]),
			callTool: vi.fn(async (_name: string, args: Record<string, unknown>) => {
				if (args.embed) {
					return { content: [{ type: "text", text: "output_too_large: try embed: false" }], isError: true };
				}
				return { content: [{ type: "text", text: "url: https://storage.example.com/docs/doc_01X?sig=abc (link expires 2026-09-17T00:00:00Z)" }], isError: false };
			}),
		};
		const io = memoryIo();
		io.files.set("/home/u/report.docx", Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(16)]));
		const controller = new AbortController();
		const fetchImpl = vi.fn(async () => {
			controller.abort();
			return new Response("markdown", { status: 200 });
		});
		vi.stubEnv("PI_CODING_AGENT_DIR", "/tmp/agent");
		const tool = buildConvertTool({ client, mcpToolName: "convert_document", env: process.env, io, fetchImpl });
		const result = await tool.execute("t1", { path: "/home/u/report.docx" } as never, controller.signal, undefined, {} as never);
		expect([...io.files.keys()].filter((k) => k.includes("lunaroute-docs"))).toHaveLength(0);
		const text = (result.content[0] as { text?: string }).text;
		expect(text).not.toContain("saved to:");
	});
});

describe("buildConvertTool renderers", () => {
	const THEME = { fg: (_c: string, t: string) => t, bold: (t: string) => t };

	test("collapsed: filename + KB (+ saved); expanded: path + url", () => {
		const tool = buildConvertTool({ client: fakeClient([]), mcpToolName: "convert_document", env: {}, io: memoryIo() });
		const collapsed = tool.renderResult?.({ details: { filename: "report.docx", bytes: 2048 } } as never, { isPartial: false, expanded: false }, THEME as never, {} as never);
		const collapsedText = (collapsed as unknown as { render(width: number): string[] }).render(80).join("\n");
		expect(collapsedText).toContain("report.docx");
		expect(collapsedText).toContain("2.0 KB");
		const saved = tool.renderResult?.({ details: { filename: "report.docx", bytes: 2048, path: "/tmp/agent/lunaroute-docs/report.md" } } as never, { isPartial: false, expanded: false }, THEME as never, {} as never);
		expect((saved as unknown as { render(width: number): string[] }).render(80).join("\n")).toContain("saved");
		const expanded = tool.renderResult?.({ details: { filename: "report.docx", bytes: 2048, path: "/tmp/agent/lunaroute-docs/report.md", artifactUrl: "https://u", ocr: true } } as never, { isPartial: false, expanded: true }, THEME as never, {} as never);
		const expandedText = (expanded as unknown as { render(width: number): string[] }).render(80).join("\n");
		expect(expandedText).toContain("/tmp/agent/lunaroute-docs/report.md");
		expect(expandedText).toContain("ocr: true");
	});
});

// ============================================================================
// Wave 4: registration orchestrator
// ============================================================================

import { registerConvertTools, _resetConvertToolsState, invalidateConvertToolRegistrations } from "../src/convert-tools.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function mcpFetch(routes: Record<string, () => unknown>, log: { method: string; params?: unknown }[]) {
	return async (_url: string, init?: RequestInit) => {
		const body = JSON.parse(String(init?.body)) as { id: number; method: string; params?: unknown };
		log.push({ method: body.method, params: body.params });
		return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: routes[body.method]?.() ?? {} }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	};
}

function fakeRegPi(options: { foreignTools?: string[] } = {}) {
	const registered: { name: string }[] = [];
	const foreign = [...(options.foreignTools ?? [])];
	let active: string[] = ["read", "bash", ...foreign];
	const pi = {
		registerTool: vi.fn((tool: { name: string }) => registered.push(tool)),
		getActiveTools: () => [...active],
		setActiveTools: (names: string[]) => {
			active = [...names];
		},
		getAllTools: () => [...foreign.map((name) => ({ name })), ...registered.map((t) => ({ name: t.name }))],
	} as unknown as ExtensionAPI;
	return { pi, registered, activeRef: () => active };
}

const CONVERT_LIST = { tools: [{ name: "convert_document" }, { name: "web_search" }] };

describe("registerConvertTools", () => {
	beforeEach(() => {
		vi.unstubAllEnvs();
		_resetConvertToolsState();
	});

	test("registers when offered, merges the active set", async () => {
		const { pi, registered, activeRef } = fakeRegPi();
		const log: { method: string }[] = [];
		const registration = await registerConvertTools(pi, { key: "lr_key", env: {}, version: "1.0.0", sessionId: "s", fetchImpl: mcpFetch({ "tools/list": () => CONVERT_LIST }, log) });
		expect(registration).toEqual({ convert: "registered" });
		expect(registered.map((t) => t.name)).toEqual(["convert_document"]);
		expect(activeRef()).toEqual(expect.arrayContaining(["read", "bash", "convert_document"]));
	});

	test("settings off → skipped-disabled, no server call, supersedes in-flight registrations", async () => {
		const { pi, registered } = fakeRegPi();
		const log: { method: string }[] = [];
		const registration = await registerConvertTools(pi, {
			key: "lr_key", env: {}, version: "1.0.0", sessionId: "s", fetchImpl: mcpFetch({}, log),
			settings: { mcp: "on", webTools: "on", searchProvider: "server", imageTools: "on", convertTools: "off" },
		});
		expect(registration).toEqual({ convert: "skipped-disabled" });
		expect(registered).toHaveLength(0);
		expect(log).toHaveLength(0);
		expect(invalidateConvertToolRegistrations).toBeDefined();
	});

	test("env LUNAROUTE_CONVERT_TOOLS=off wins over settings on", async () => {
		const { pi, registered } = fakeRegPi();
		const registration = await registerConvertTools(pi, {
			key: "lr_key", env: { LUNAROUTE_CONVERT_TOOLS: "off" }, version: "1.0.0", sessionId: "s",
			fetchImpl: mcpFetch({}, []),
		});
		expect(registration.convert).toBe("skipped-disabled");
		expect(registered).toHaveLength(0);
	});

	test("server without the tool → skipped-server; unreachable → error, never throws", async () => {
		const { pi } = fakeRegPi();
		const without = await registerConvertTools(pi, { key: "lr_key", env: {}, version: "1.0.0", sessionId: "s", fetchImpl: mcpFetch({ "tools/list": () => ({ tools: [{ name: "web_search" }] }) }, []) });
		expect(without).toEqual({ convert: "skipped-server" });
		const unreachable = await registerConvertTools(pi, { key: "lr_key", env: {}, version: "1.0.0", sessionId: "s", fetchImpl: vi.fn(async () => new Response("nope", { status: 503 })) });
		expect(unreachable.convert).toBe("skipped-server");
		expect(unreachable.error).toBeTruthy();
	});

	test("a foreign same-named tool is neither registered nor ever toggled by us", async () => {
		const { pi, registered, activeRef } = fakeRegPi({ foreignTools: ["convert_document"] });
		const registration = await registerConvertTools(pi, { key: "lr_key", env: {}, version: "1.0.0", sessionId: "s", fetchImpl: mcpFetch({ "tools/list": () => CONVERT_LIST }, []) });
		expect(registration).toEqual({ convert: "skipped-existing" });
		expect(registered).toHaveLength(0);
		expect(activeRef()).toContain("convert_document"); // foreign tool untouched
	});

	test("idempotent re-entry re-activates without re-registering; drift deactivates", async () => {
		const { pi, registered, activeRef } = fakeRegPi();
		const fetchImpl = mcpFetch({ "tools/list": () => CONVERT_LIST }, []);
		await registerConvertTools(pi, { key: "lr_key", env: {}, version: "1.0.0", sessionId: "s", fetchImpl });
		expect(pi.registerTool).toHaveBeenCalledTimes(1);
		await registerConvertTools(pi, { key: "lr_key", env: {}, version: "1.0.0", sessionId: "s", fetchImpl });
		expect(pi.registerTool).toHaveBeenCalledTimes(1);
		expect(activeRef()).toContain("convert_document");
		// Drift: server stops offering it.
		await registerConvertTools(pi, { key: "lr_key", env: {}, version: "1.0.0", sessionId: "s", fetchImpl: mcpFetch({ "tools/list": () => ({ tools: [] }) }, []) });
		expect(activeRef()).not.toContain("convert_document");
		expect(registered).toHaveLength(1); // still registered in pi, deactivated
		// Re-offer: re-activated (ownership kept).
		await registerConvertTools(pi, { key: "lr_key", env: {}, version: "1.0.0", sessionId: "s", fetchImpl });
		expect(pi.registerTool).toHaveBeenCalledTimes(1);
		expect(activeRef()).toContain("convert_document");
	});

	test("rotated keys reach the already-registered tool through the swappable client", async () => {
		const { pi, registered } = fakeRegPi();
		await registerConvertTools(pi, { key: "lr_old", env: {}, version: "1.0.0", sessionId: "s", fetchImpl: mcpFetch({ "tools/list": () => CONVERT_LIST }, []) });
		const tool = registered[0] as unknown as { execute: (id: string, params: unknown, signal: AbortSignal, onUpdate: unknown, ctx: unknown) => Promise<{ content: { type: string; text?: string }[] }> };
		// Re-login with a rotated key + a failed catalog fetch — the swap must happen anyway.
		await registerConvertTools(pi, { key: "lr_rotated", env: {}, version: "1.0.0", sessionId: "s", fetchImpl: vi.fn(async () => new Response("nope", { status: 503 })) });
		const newFetch = mcpFetch({ "tools/call": () => ({ content: [{ type: "text", text: "# md" }], isError: false }) }, []);
		await registerConvertTools(pi, { key: "lr_rotated", env: {}, version: "1.0.0", sessionId: "s", fetchImpl: newFetch });
		const result = await tool.execute("t1", { url: "https://example.com/x.docx" }, new AbortController().signal, undefined, {});
		expect((result.content[0] as { text?: string }).text).toBe("# md");
	});

	test("a superseded registration (older tools/list resolving late) never mutates", async () => {
		const { pi, activeRef } = fakeRegPi();
		let resolveA: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			resolveA = resolve;
		});
		const deferredFetch = async (_url: string, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body)) as { id: number; method: string };
			if (body.method === "tools/list") {
				await gate;
				return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: [] } }), { status: 200, headers: { "content-type": "application/json" } });
			}
			return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} }), { status: 200, headers: { "content-type": "application/json" } });
		};
		const a = registerConvertTools(pi, { key: "lr_key", env: {}, version: "1.0.0", sessionId: "s", fetchImpl: deferredFetch });
		await Promise.resolve();
		await registerConvertTools(pi, { key: "lr_key", env: {}, version: "1.0.0", sessionId: "s", fetchImpl: mcpFetch({ "tools/list": () => CONVERT_LIST }, []) });
		expect(activeRef()).toContain("convert_document");
		resolveA();
		const outcome = await a;
		expect(outcome.convert).toBe("skipped-server");
		expect(outcome.error).toContain("superseded");
		expect(activeRef()).toContain("convert_document");
	});
});

describe("roborev job 1713: fallback dedup, abort-safe pre-existing files, temp cleanup", () => {
	const DOCX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64)]);
	const LINK_TEXT = "url: https://storage.example.com/docs/doc_01X?sig=abc (link expires 2026-09-17T00:00:00Z)";

	function bothEmbedsFailClient() {
		return {
			listTools: vi.fn(async () => [] as string[]),
			callTool: vi.fn(async (_name: string, args: Record<string, unknown>) => ({
				content: [
					{
						type: "text",
						text: args.embed
							? "output_too_large: document output is 2000000 bytes; inline cap is 1048576; try embed: false"
							: "output_too_large: document output exceeds MCP_DOC_MAX_OUTPUT_BYTES",
					},
				],
				isError: true,
			})),
		};
	}

	test("a double output_too_large runs the fallback exactly once (no re-entry)", async () => {
		const client = bothEmbedsFailClient();
		const io = memoryIo();
		io.files.set("/home/u/report.docx", DOCX);
		const tool = buildConvertTool({ client, mcpToolName: "convert_document", env: {}, io });
		await expect(tool.execute("t1", { path: "/home/u/report.docx" } as never, AC(), undefined, {} as never)).rejects.toThrow(/output_too_large/);
		const embeds = client.callTool.mock.calls.map(([, args]) => (args as Record<string, unknown>).embed);
		expect(embeds).toEqual([true, false]); // exactly one embed:true + one fallback — no duplicate fallback
	});

	test("aborting after the rename never deletes a pre-existing identical document", async () => {
		const client = {
			listTools: vi.fn(async () => [] as string[]),
			callTool: vi.fn(async (_name: string, args: Record<string, unknown>) => {
				if (args.embed) {
					return { content: [{ type: "text", text: "output_too_large: try embed: false" }], isError: true };
				}
				return { content: [{ type: "text", text: LINK_TEXT }], isError: false };
			}),
		};
		const io = memoryIo();
		io.files.set("/home/u/report.docx", DOCX);
		const preExisting = Buffer.from("# same content\n");
		io.files.set("/tmp/agent/lunaroute-docs/report.md", preExisting); // already there, identical
		const controller = new AbortController();
		const fetchImpl = vi.fn(async () => new Response("# same content\n", { status: 200 }));
		const origRename = io.rename.bind(io);
		io.rename = async (from: string, to: string) => {
			await origRename(from, to); // the rename lands
			controller.abort(); // …then cancellation arrives
		};
		vi.stubEnv("PI_CODING_AGENT_DIR", "/tmp/agent");
		const tool = buildConvertTool({ client, mcpToolName: "convert_document", env: process.env, io, fetchImpl });
		const result = await tool.execute("t1", { path: "/home/u/report.docx" } as never, controller.signal, undefined, {} as never);
		expect(io.files.get("/tmp/agent/lunaroute-docs/report.md")).toEqual(preExisting); // untouched
		// Never-delete-after-rename (roborev 1727): the save completed before
		// the cancellation landed, so the result reports it honestly (pi
		// discards cancelled-call results anyway).
		expect((result.content[0] as { text?: string }).text).toContain("saved to:");
	});

	test("a failed rename cleans the real temp file (no .tmp leak)", async () => {
		const client = {
			listTools: vi.fn(async () => [] as string[]),
			callTool: vi.fn(async (_name: string, args: Record<string, unknown>) => {
				if (args.embed) {
					return { content: [{ type: "text", text: "output_too_large: try embed: false" }], isError: true };
				}
				return { content: [{ type: "text", text: LINK_TEXT }], isError: false };
			}),
		};
		const io = memoryIo();
		io.files.set("/home/u/report.docx", DOCX);
		io.rename = async () => {
			throw new Error("disk full");
		};
		const fetchImpl = vi.fn(async () => new Response("# content\n", { status: 200 }));
		vi.stubEnv("PI_CODING_AGENT_DIR", "/tmp/agent");
		const tool = buildConvertTool({ client, mcpToolName: "convert_document", env: process.env, io, fetchImpl });
		const result = await tool.execute("t1", { path: "/home/u/report.docx" } as never, AC(), undefined, {} as never);
		const leftovers = [...io.files.keys()].filter((k) => k.endsWith(".tmp"));
		expect(leftovers).toEqual([]);
		expect((result.content[0] as { text?: string }).text).toContain("could not be saved locally");
	});
});

describe("roborev job 1715: text-upload policy + concurrent-writer-safe abort cleanup", () => {
	const LINK_TEXT = "url: https://storage.example.com/docs/doc_01X?sig=abc (link expires 2026-09-17T00:00:00Z)";

	function fallbackClient() {
		return {
			listTools: vi.fn(async () => [] as string[]),
			callTool: vi.fn(async (_name: string, args: Record<string, unknown>) => {
				if (args.embed) {
					return { content: [{ type: "text", text: "output_too_large: try embed: false" }], isError: true };
				}
				return { content: [{ type: "text", text: LINK_TEXT }], isError: false };
			}),
		};
	}

	test("text is only converted with a .csv claim; dotfiles and other extensions are rejected locally", async () => {
		const client = fakeClient([{ type: "text", text: "# md\n" }]);
		const io = memoryIo();
		const tool = buildConvertTool({ client, mcpToolName: "convert_document", env: {}, io });
		// .csv path → accepted.
		io.files.set("/home/u/data.csv", Buffer.from("a,b\n1,2\n", "utf8"));
		await tool.execute("t1", { path: "/home/u/data.csv" } as never, AC(), undefined, {} as never);
		expect(client.callTool).toHaveBeenCalledTimes(1);
		// extensionless path + explicit .csv filename → accepted.
		io.files.set("/home/u/download", Buffer.from("a,b\n1,2\n", "utf8"));
		await tool.execute("t1", { path: "/home/u/download", filename: "report.csv" } as never, AC(), undefined, {} as never);
		expect(client.callTool).toHaveBeenCalledTimes(2);
		// secrets stay on this machine: dotfiles, keys, source, wrong extensions.
		for (const p of ["/home/u/.env", "/home/u/id_rsa", "/home/u/.ssh/config", "/home/u/notes.txt", "/home/u/main.ts"]) {
			io.files.set(p, Buffer.from("some text, with a comma\n", "utf8"));
			await expect(tool.execute("t1", { path: p } as never, AC(), undefined, {} as never)).rejects.toThrow(/csv/i);
		}
		expect(client.callTool).toHaveBeenCalledTimes(2); // nothing new left the machine
	});

	test("an explicit .csv claim cannot launder an extensionless-but-named file", async () => {
		const client = fallbackClient();
		const io = memoryIo();
		io.files.set("/home/u/.aws/credentials", Buffer.from("[default]\naws_access_key_id=SECRET, x\n", "utf8"));
		const tool = buildConvertTool({ client, mcpToolName: "convert_document", env: {}, io });
		await expect(tool.execute("t1", { path: "/home/u/.aws/credentials", filename: "report.csv" } as never, AC(), undefined, {} as never)).rejects.toThrow(/csv/i);
		expect(client.callTool).not.toHaveBeenCalled();
	});

	test("binary formats are unaffected by the text policy (magic wins over any name)", async () => {
		const client = fallbackClient();
		const io = memoryIo();
		io.files.set("/home/u/renamed-noext", Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(32)]));
		const tool = buildConvertTool({ client, mcpToolName: "convert_document", env: {}, io });
		await tool.execute("t1", { path: "/home/u/renamed-noext" } as never, AC(), undefined, {} as never);
		expect(client.callTool).toHaveBeenCalledWith("convert_document", expect.objectContaining({ filename: "renamed-noext" }), expect.anything());
	});

	test("post-rename abort never removes a concurrent writer's output", async () => {
		const client = fallbackClient();
		const io = memoryIo();
		io.files.set("/home/u/report.docx", Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(32)]));
		const controller = new AbortController();
		const fetchImpl = vi.fn(async () => new Response("# ours\n", { status: 200 }));
		const otherWriter = Buffer.from("# a concurrent invocation's output\n");
		const origRename = io.rename.bind(io);
		io.rename = async (from: string, to: string) => {
			await origRename(from, to); // our rename lands
			io.files.set(to, otherWriter); // …then a concurrent writer overwrites…
			controller.abort(); // …then cancellation arrives
		};
		vi.stubEnv("PI_CODING_AGENT_DIR", "/tmp/agent");
		const tool = buildConvertTool({ client, mcpToolName: "convert_document", env: process.env, io, fetchImpl });
		await tool.execute("t1", { path: "/home/u/report.docx" } as never, controller.signal, undefined, {} as never);
		expect(io.files.get("/tmp/agent/lunaroute-docs/report.md")).toEqual(otherWriter); // preserved — never deleted by another invocation's abort
	});
});

describe("roborev job 1727: windows separators + never-delete-after-rename", () => {
	test("windows-style hidden paths cannot launder text past the guard", async () => {
		const client = fakeClient([{ type: "text", text: "# md\n" }]);
		const io = memoryIo();
		// A .csv-named secrets file inside a backslash-hidden directory: the
		// extension check passes, so only the hidden-path guard can stop it.
		io.files.set("C:\\Users\\me\\.ssh\\config.csv", Buffer.from("Host *, x\n", "utf8"));
		const tool = buildConvertTool({ client, mcpToolName: "convert_document", env: {}, io });
		await expect(tool.execute("t1", { path: "C:\\Users\\me\\.ssh\\config.csv" } as never, AC(), undefined, {} as never)).rejects.toThrow(/csv/i);
		expect(client.callTool).not.toHaveBeenCalled();
	});

	test("post-rename abort keeps the completed document and reports it honestly (never deletes)", async () => {
		const client = {
			listTools: vi.fn(async () => [] as string[]),
			callTool: vi.fn(async (_name: string, args: Record<string, unknown>) => {
				if (args.embed) {
					return { content: [{ type: "text", text: "output_too_large: try embed: false" }], isError: true };
				}
				return { content: [{ type: "text", text: "url: https://storage.example.com/docs/doc_01X?sig=abc (link expires 2026-09-17T00:00:00Z)" }], isError: false };
			}),
		};
		const io = memoryIo();
		io.files.set("/home/u/report.docx", Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(32)]));
		const controller = new AbortController();
		const fetchImpl = vi.fn(async () => new Response("# ours\n", { status: 200 }));
		const origRename = io.rename.bind(io);
		io.rename = async (from: string, to: string) => {
			await origRename(from, to);
			controller.abort(); // cancellation lands after the rename completed
		};
		vi.stubEnv("PI_CODING_AGENT_DIR", "/tmp/agent");
		const tool = buildConvertTool({ client, mcpToolName: "convert_document", env: process.env, io, fetchImpl });
		const result = await tool.execute("t1", { path: "/home/u/report.docx" } as never, controller.signal, undefined, {} as never);
		// The completed document is kept and reported — never deleted.
		expect(io.files.get("/tmp/agent/lunaroute-docs/report.md")).toEqual(Buffer.from("# ours\n"));
		expect((result.content[0] as { text?: string }).text).toContain("saved to:");
		expect((result.details as { path?: string }).path).toBe("/tmp/agent/lunaroute-docs/report.md");
	});
});
