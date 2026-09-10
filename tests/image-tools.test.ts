import { beforeEach, describe, expect, test, vi } from "vitest";
import {
	_resetImageToolsState,
	parseImageResultText,
	readUntilLimit,
	parseUploadResultText,
	resolveImageDir,
	UPLOAD_MAX_BYTES,
} from "../src/image-tools.js";

const GENERATED_TEXT = [
	"Generated 1024x1024 png with flux-2-klein (seed 42, 28 steps)",
	"id: img_01JD2W3Q4R5T6Y7U8I9O0P1A2B",
	"url: https://storage.example.com/img?sig=abc (link expires 2026-09-16T00:00:00Z)",
	"image expires: 2026-09-16T00:00:00Z",
].join("\n");

const EDITED_TEXT = [
	"Edited into 768x768 jpeg with flux-2-klein-edit",
	"id: img_01JD2W3Q4R5T6Y7U8I9O0P1A2C",
	"from: img_01JD2W3Q4R5T6Y7U8I9O0P1A2B",
	"url: https://storage.example.com/img2?sig=def (link expires 2026-09-15T00:00:00Z)",
	"image expires: 2026-09-15T00:00:00Z",
].join("\n");

const UPLOADED_TEXT = [
	"uploaded img_01JD2W3Q4R5T6Y7U8I9O0P1A2D (512x512 webp, 1.4 MiB)",
	"url: https://storage.example.com/img3?sig=ghi (link expires 2026-09-12T00:00:00Z)",
].join("\n");

describe("parseImageResultText (line-based server contract, mcp.rs)", () => {
	test("parses a generate result: dims, format, model, seed/steps, id, url, expiries", () => {
		const r = parseImageResultText(GENERATED_TEXT);
		expect(r).toMatchObject({
			verb: "Generated",
			width: 1024,
			height: 1024,
			format: "png",
			model: "flux-2-klein",
			seed: 42,
			steps: 28,
			id: "img_01JD2W3Q4R5T6Y7U8I9O0P1A2B",
			url: "https://storage.example.com/img?sig=abc",
			urlExpires: "2026-09-16T00:00:00Z",
			imageExpires: "2026-09-16T00:00:00Z",
		});
		expect(r.rawText).toBeUndefined();
	});

	test("parses an edit result: verb, from: parents, seed-only detail", () => {
		const r = parseImageResultText(EDITED_TEXT);
		expect(r).toMatchObject({
			verb: "Edited into",
			width: 768,
			height: 768,
			format: "jpeg",
			model: "flux-2-klein-edit",
			seed: undefined,
			steps: undefined,
			id: "img_01JD2W3Q4R5T6Y7U8I9O0P1A2C",
			from: ["img_01JD2W3Q4R5T6Y7U8I9O0P1A2B"],
		});
	});

	test("seed+steps detail variants: seed only, steps only, none", () => {
		const seedOnly = parseImageResultText(
			GENERATED_TEXT.replace("(seed 42, 28 steps)", "(seed 7)"),
		);
		expect(seedOnly.seed).toBe(7);
		expect(seedOnly.steps).toBeUndefined();
		const none = parseImageResultText(GENERATED_TEXT.replace(" (seed 42, 28 steps)", ""));
		expect(none.seed).toBeUndefined();
		expect(none.steps).toBeUndefined();
	});

	test("degraded url line (temporarily unavailable) leaves url unset, id intact", () => {
		const r = parseImageResultText(
			GENERATED_TEXT.replace(
				"url: https://storage.example.com/img?sig=abc (link expires 2026-09-16T00:00:00Z)",
				"url: (temporarily unavailable — GET /v1/images/img_01JD2W3Q4R5T6Y7U8I9O0P1A2B/content)",
			),
		);
		expect(r.url).toBeUndefined();
		expect(r.urlExpires).toBeUndefined();
		expect(r.id).toBe("img_01JD2W3Q4R5T6Y7U8I9O0P1A2B");
	});

	test("from: line splits multiple parents", () => {
		const r = parseImageResultText(EDITED_TEXT.replace("from: img_01JD2W3Q4R5T6Y7U8I9O0P1A2B", "from: img_a, img_b"));
		expect(r.from).toEqual(["img_a", "img_b"]);
	});

	test("unparseable text keeps rawText (tolerant, web-tools pattern)", () => {
		const r = parseImageResultText("something entirely different");
		expect(r.rawText).toBe("something entirely different");
		expect(r.id).toBe("");
	});
});

describe("parseUploadResultText", () => {
	test("parses id, dims, format, MiB, url", () => {
		const r = parseUploadResultText(UPLOADED_TEXT);
		expect(r).toMatchObject({
			id: "img_01JD2W3Q4R5T6Y7U8I9O0P1A2D",
			width: 512,
			height: 512,
			format: "webp",
			mib: 1.4,
			url: "https://storage.example.com/img3?sig=ghi",
			urlExpires: "2026-09-12T00:00:00Z",
		});
		expect(r.rawText).toBeUndefined();
	});

	test("unparseable upload text keeps rawText", () => {
		expect(parseUploadResultText("nope").rawText).toBe("nope");
	});
});

describe("resolveImageDir (kata e30g: per-installation central folder)", () => {
	test("default: <agentDir>/lunaroute-images", () => {
		expect(resolveImageDir({ PI_CODING_AGENT_DIR: "/tmp/agent" })).toBe("/tmp/agent/lunaroute-images");
	});

	test("LUNAROUTE_IMAGE_DIR (absolute) wins over the agent dir", () => {
		expect(resolveImageDir({ PI_CODING_AGENT_DIR: "/tmp/agent", LUNAROUTE_IMAGE_DIR: "/data/imgs" })).toBe("/data/imgs");
	});

	test("upload cap matches the server default ceiling (11 MiB)", () => {
		expect(UPLOAD_MAX_BYTES).toBe(11 * 1024 * 1024);
	});
});

// ============================================================================
// Wave 2: tool builders, renderers, registration
// ============================================================================

import { buildEditImageTool, buildGenerateImageTool, buildUploadImageTool, extractModelEnum, registerImageTools, type ImageIo } from "../src/image-tools.js";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";

const THEME = { fg: (_c: string, t: string) => t, bold: (t: string) => t };

function mcpFetch(routes: Record<string, () => unknown>, log: { method: string; params?: unknown }[]) {
	return async (_url: string, init?: RequestInit) => {
		const body = JSON.parse(String(init?.body)) as { id: number; method: string; params?: unknown };
		log.push({ method: body.method, params: body.params });
		const route = routes[body.method];
		return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: route ? route() : {} }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	};
}

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
			const bytes = files.get(path) ?? new Uint8Array();
			return bytes.subarray(0, maxBytes);
		},
	};
}

function fakeClient(parts: { type: string; text?: string; data?: string; mimeType?: string }[]) {
	return {
		listTools: vi.fn(async () => [] as string[]),
		callTool: vi.fn(async () => ({ content: parts, isError: false })),
	};
}

const AC = () => new AbortController().signal;

describe("buildGenerateImageTool", () => {
	test("calls the MCP tool with embed:true + passthrough args, saves inline bytes, reports the path", async () => {
		const client = fakeClient([
			{ type: "text", text: GENERATED_TEXT },
			{ type: "image", data: Buffer.from("pngbytes").toString("base64"), mimeType: "image/png" },
		]);
		const io = memoryIo();
		vi.stubEnv("PI_CODING_AGENT_DIR", "/tmp/agent");
		const tool = buildGenerateImageTool({ client, mcpToolName: "generate_image", env: process.env, io });
		const result = await tool.execute("t1", { prompt: "a cat", model: "flux-2-klein", size: "1024x1024", seed: 7 } as never, AC(), undefined, {} as never);
		expect(client.callTool).toHaveBeenCalledWith("generate_image", { prompt: "a cat", model: "flux-2-klein", size: "1024x1024", seed: 7, embed: true }, expect.anything());
		const savedPath = "/tmp/agent/lunaroute-images/img_01JD2W3Q4R5T6Y7U8I9O0P1A2B.png";
		expect(io.files.get(savedPath)).toEqual(Buffer.from("pngbytes"));
		expect((result.content[0] as { type?: string }).type).toBe("text");
		expect((result.content[0] as { text?: string }).text).toContain("saved to:");
		expect((result.content[0] as { text?: string }).text).toContain(savedPath);
		expect(result.details).toMatchObject({ id: "img_01JD2W3Q4R5T6Y7U8I9O0P1A2B", path: savedPath, url: "https://storage.example.com/img?sig=abc", width: 1024, height: 1024, format: "png" });
	});

	test("embed dropped (no image part) → fetches the signed url and saves", async () => {
		const client = fakeClient([{ type: "text", text: GENERATED_TEXT }]);
		const io = memoryIo();
		const fetchImpl = vi.fn(async () => new Response("fetchedbytes", { status: 200 }));
		vi.stubEnv("PI_CODING_AGENT_DIR", "/tmp/agent");
		const tool = buildGenerateImageTool({ client, mcpToolName: "generate_image", env: process.env, io, fetchImpl });
		const result = await tool.execute("t1", { prompt: "p", model: "m" } as never, AC(), undefined, {} as never);
		expect(fetchImpl).toHaveBeenCalledWith("https://storage.example.com/img?sig=abc", expect.anything());
		expect(io.files.get("/tmp/agent/lunaroute-images/img_01JD2W3Q4R5T6Y7U8I9O0P1A2B.png")).toEqual(Buffer.from("fetchedbytes"));
		expect(result.details).toMatchObject({ path: "/tmp/agent/lunaroute-images/img_01JD2W3Q4R5T6Y7U8I9O0P1A2B.png" });
	});

	test("no bytes and degraded url → not saved, note in text, id still surfaced", async () => {
		const degraded = GENERATED_TEXT.replace(
			"url: https://storage.example.com/img?sig=abc (link expires 2026-09-16T00:00:00Z)",
			"url: (temporarily unavailable — GET /v1/images/img_01JD2W3Q4R5T6Y7U8I9O0P1A2B/content)",
		);
		const client = fakeClient([{ type: "text", text: degraded }]);
		const io = memoryIo();
		vi.stubEnv("PI_CODING_AGENT_DIR", "/tmp/agent");
		const tool = buildGenerateImageTool({ client, mcpToolName: "generate_image", env: process.env, io });
		const result = await tool.execute("t1", { prompt: "p", model: "m" } as never, AC(), undefined, {} as never);
		expect(io.files.size).toBe(0);
		expect((result.content[0] as { text?: string }).text).toContain("not saved locally");
		expect(result.details).toMatchObject({ id: "img_01JD2W3Q4R5T6Y7U8I9O0P1A2B", path: undefined });
	});

	test("renderers: collapsed shows id/dims/format/saved; expanded shows the path", () => {
		const client = fakeClient([]);
		vi.stubEnv("PI_CODING_AGENT_DIR", "/tmp/agent");
		const tool = buildGenerateImageTool({ client, mcpToolName: "generate_image", env: process.env });
		const details = { id: "img_X", path: "/tmp/agent/lunaroute-images/img_X.png", width: 512, height: 512, format: "png", model: "flux-2-klein", url: "https://u" };
		const collapsed = tool.renderResult?.({ details } as never, { isPartial: false, expanded: false }, THEME as never, {} as never);
		const text = (collapsed as unknown as { render(width: number): string[] }).render(80).join("\n");
		expect(text).toContain("img_X");
		expect(text).toContain("512x512");
		expect(text).toContain("saved");
		const expanded = tool.renderResult?.({ details } as never, { isPartial: false, expanded: true }, THEME as never, {} as never);
		const expandedText = (expanded as unknown as { render(width: number): string[] }).render(80).join("\n");
		expect(expandedText).toContain("/tmp/agent/lunaroute-images/img_X.png");
	});
});

describe("buildEditImageTool", () => {
	test("passes image_ids through, parses the edit result (from: parents)", async () => {
		const client = fakeClient([
			{ type: "text", text: EDITED_TEXT },
			{ type: "image", data: Buffer.from("jpegbytes").toString("base64"), mimeType: "image/jpeg" },
		]);
		const io = memoryIo();
		vi.stubEnv("PI_CODING_AGENT_DIR", "/tmp/agent");
		const tool = buildEditImageTool({ client, mcpToolName: "edit_image", env: process.env, io });
		const result = await tool.execute("t1", { prompt: "make it blue", model: "flux-2-klein-edit", image_ids: ["img_parent"] } as never, AC(), undefined, {} as never);
		expect(client.callTool).toHaveBeenCalledWith("edit_image", { prompt: "make it blue", model: "flux-2-klein-edit", image_ids: ["img_parent"], embed: true }, expect.anything());
		expect(io.files.get("/tmp/agent/lunaroute-images/img_01JD2W3Q4R5T6Y7U8I9O0P1A2C.jpg")).toEqual(Buffer.from("jpegbytes"));
		expect(result.details).toMatchObject({ from: ["img_01JD2W3Q4R5T6Y7U8I9O0P1A2B"], format: "jpeg" });
	});
});

describe("buildUploadImageTool", () => {
	test("path → reads the file, sends base64 data, appends the edit hint", async () => {
		const client = fakeClient([{ type: "text", text: UPLOADED_TEXT }]);
		const io = memoryIo();
		const catpng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
		io.files.set("/home/u/cat.png", catpng);
		const tool = buildUploadImageTool({ client, mcpToolName: "upload_image", env: process.env, io });
		const result = await tool.execute("t1", { path: "/home/u/cat.png" } as never, AC(), undefined, {} as never);
		expect(client.callTool).toHaveBeenCalledWith("upload_image", { data: catpng.toString("base64"), mime_type: "image/png" }, expect.anything());
		expect((result.content[0] as { text?: string }).text).toContain("pass this id to edit_image's image_ids");
		expect(result.details).toMatchObject({ id: "img_01JD2W3Q4R5T6Y7U8I9O0P1A2D", width: 512, format: "webp" });
	});

	test("url → passes the url through untouched", async () => {
		const client = fakeClient([{ type: "text", text: UPLOADED_TEXT }]);
		const tool = buildUploadImageTool({ client, mcpToolName: "upload_image", env: process.env, io: memoryIo() });
		await tool.execute("t1", { url: "https://example.com/cat.png" } as never, AC(), undefined, {} as never);
		expect(client.callTool).toHaveBeenCalledWith("upload_image", { url: "https://example.com/cat.png" }, expect.anything());
	});

	test("oversize file → fails fast before any MCP call", async () => {
		const client = fakeClient([]);
		const io = memoryIo();
		io.files.set("/home/u/huge.png", new Uint8Array(UPLOAD_MAX_BYTES + 1));
		const tool = buildUploadImageTool({ client, mcpToolName: "upload_image", env: process.env, io });
		await expect(tool.execute("t1", { path: "/home/u/huge.png" } as never, AC(), undefined, {} as never)).rejects.toThrow(/11 MiB/);
		expect(client.callTool).not.toHaveBeenCalled();
	});

	test("both or neither of path/url → rejected locally", async () => {
		const client = fakeClient([]);
		const tool = buildUploadImageTool({ client, mcpToolName: "upload_image", env: process.env, io: memoryIo() });
		await expect(tool.execute("t1", {} as never, AC(), undefined, {} as never)).rejects.toThrow(/exactly one of path or url/i);
		await expect(tool.execute("t1", { path: "/a", url: "https://b" } as never, AC(), undefined, {} as never)).rejects.toThrow(/exactly one of path or url/i);
	});
});

describe("extractModelEnum", () => {
	test("extracts the enum + description from a tools/list inputSchema", () => {
		const schema = {
			type: "object",
			properties: { model: { type: "string", enum: ["flux-2-klein", "flux-2-klein-edit"], description: "Which image model. flux-2-klein: default size 1024x1024" } },
		};
		expect(extractModelEnum(schema)).toEqual({
			enum: ["flux-2-klein", "flux-2-klein-edit"],
			description: "Which image model. flux-2-klein: default size 1024x1024",
		});
	});

	test("missing/odd schema → undefined", () => {
		expect(extractModelEnum(undefined)).toBeUndefined();
		expect(extractModelEnum({ properties: {} })).toBeUndefined();
		expect(extractModelEnum({ properties: { model: { type: "string" } } })).toBeUndefined();
	});
});

function fakePi(options: { foreignTools?: string[] } = {}) {
	const registered: ToolDefinition<never, never>[] = [];
	const foreign = [...(options.foreignTools ?? [])];
	let active: string[] = ["read", "bash", ...foreign];
	const pi = {
		registerTool: vi.fn((tool: ToolDefinition<never, never>) => registered.push(tool)),
		getActiveTools: () => [...active],
		setActiveTools: (names: string[]) => {
			active = [...names];
		},
		getAllTools: () => [...foreign.map((name) => ({ name })), ...registered.map((t) => ({ name: t.name }))],
	} as unknown as ExtensionAPI;
	return { pi, registered, activeRef: () => active };
}

const IMAGE_TOOLS_LIST = {
	tools: [
		{ name: "web_search", inputSchema: { type: "object", properties: {} } },
		{
			name: "generate_image",
			inputSchema: { type: "object", properties: { model: { type: "string", enum: ["flux-2-klein"], description: "flux-2-klein: default size 1024x1024" } } },
		},
		{
			name: "edit_image",
			inputSchema: { type: "object", properties: { model: { type: "string", enum: ["flux-2-klein-edit"], description: "edits" } } },
		},
		{ name: "upload_image", inputSchema: { type: "object", properties: {} } },
	],
};

describe("registerImageTools", () => {
	beforeEach(() => {
		vi.unstubAllEnvs();
		_resetImageToolsState();
	});

	test("registers all three offered tools, bakes the model enums, merges the active set", async () => {
		const { pi, registered, activeRef } = fakePi();
		const log: { method: string; params?: unknown }[] = [];
		const fetchImpl = mcpFetch({ "tools/list": () => IMAGE_TOOLS_LIST }, log);
		const registration = await registerImageTools(pi, { key: "lr_key", env: {}, version: "1.0.0", sessionId: "s", fetchImpl });
		expect(registration).toMatchObject({ generateImage: "registered", editImage: "registered", uploadImage: "registered" });
		expect(registered.map((t) => t.name).sort()).toEqual(["edit_image", "generate_image", "upload_image"]);
		expect(activeRef()).toEqual(expect.arrayContaining(["read", "bash", "generate_image", "edit_image", "upload_image"]));
		const generate = registered.find((t) => t.name === "generate_image");
		const model = (generate?.parameters as unknown as { properties: { model: { anyOf?: { const: string }[] } } }).properties.model;
		expect(model.anyOf).toEqual([{ type: "string", const: "flux-2-klein" }]);
		expect(model).toMatchObject({ description: expect.stringContaining("default size 1024x1024") });
	});

	test("settings off → skipped-disabled, no server call", async () => {
		const { pi, registered } = fakePi();
		const log: { method: string; params?: unknown }[] = [];
		const fetchImpl = mcpFetch({}, log);
		const registration = await registerImageTools(pi, {
			key: "lr_key", env: {}, version: "1.0.0", sessionId: "s", fetchImpl,
			settings: { mcp: "on", webTools: "on", searchProvider: "server", imageTools: "off" },
		});
		expect(registration).toMatchObject({ generateImage: "skipped-disabled", editImage: "skipped-disabled", uploadImage: "skipped-disabled" });
		expect(registered).toHaveLength(0);
		expect(log).toHaveLength(0);
	});

	test("env LUNAROUTE_IMAGE_TOOLS=off wins over settings on", async () => {
		const { pi, registered } = fakePi();
		const registration = await registerImageTools(pi, {
			key: "lr_key", env: { LUNAROUTE_IMAGE_TOOLS: "off" }, version: "1.0.0", sessionId: "s",
			fetchImpl: mcpFetch({}, []),
		});
		expect(registration.generateImage).toBe("skipped-disabled");
		expect(registered).toHaveLength(0);
	});

	test("server without edit_image → edit skipped-server, others registered", async () => {
		const { pi, registered } = fakePi();
		const toolsList = { tools: IMAGE_TOOLS_LIST.tools.filter((t) => t.name !== "edit_image") };
		const fetchImpl = mcpFetch({ "tools/list": () => toolsList }, []);
		const registration = await registerImageTools(pi, { key: "lr_key", env: {}, version: "1.0.0", sessionId: "s", fetchImpl });
		expect(registration).toMatchObject({ generateImage: "registered", editImage: "skipped-server", uploadImage: "registered" });
		expect(registered.map((t) => t.name).sort()).toEqual(["generate_image", "upload_image"]);
	});

	test("server unreachable → all skipped-server with error, never throws", async () => {
		const { pi, registered } = fakePi();
		const fetchImpl = vi.fn(async () => new Response("nope", { status: 503 }));
		const registration = await registerImageTools(pi, { key: "lr_key", env: {}, version: "1.0.0", sessionId: "s", fetchImpl });
		expect(registration.generateImage).toBe("skipped-server");
		expect(registration.error).toBeTruthy();
		expect(registered).toHaveLength(0);
	});

	test("registers without baked enums when the client cannot provide descriptors", async () => {
		const { pi, registered } = fakePi();
		const fetchImpl = mcpFetch({ "tools/list": () => ({ tools: [{ name: "generate_image" }, { name: "upload_image" }] }) }, []);
		const registration = await registerImageTools(pi, { key: "lr_key", env: {}, version: "1.0.0", sessionId: "s", fetchImpl });
		expect(registration).toMatchObject({ generateImage: "registered", uploadImage: "registered" });
		const generate = registered.find((t) => t.name === "generate_image");
		const model = (generate?.parameters as unknown as { properties: { model: { type: string } } }).properties.model;
		expect(model.type).toBe("string");
	});
});

describe("registerImageTools idempotency (roborev job 1636)", () => {
	beforeEach(() => {
		vi.unstubAllEnvs();
		_resetImageToolsState();
	});

	test("a second session_start re-entry does not re-register: tools stay ours, active set intact", async () => {
		const { pi, registered, activeRef } = fakePi();
		const fetchImpl = mcpFetch({ "tools/list": () => IMAGE_TOOLS_LIST }, []);
		const first = await registerImageTools(pi, { key: "lr_key", env: {}, version: "1.0.0", sessionId: "s", fetchImpl });
		expect(first.generateImage).toBe("registered");
		expect(pi.registerTool).toHaveBeenCalledTimes(3);
		const second = await registerImageTools(pi, { key: "lr_key", env: {}, version: "1.0.0", sessionId: "s", fetchImpl });
		expect(second).toMatchObject({ generateImage: "registered", editImage: "registered", uploadImage: "registered" });
		// No duplicate registrations — still exactly 3.
		expect(pi.registerTool).toHaveBeenCalledTimes(3);
		expect(registered).toHaveLength(3);
		expect(activeRef()).toEqual(expect.arrayContaining(["generate_image", "edit_image", "upload_image"]));
	});

	test("re-entry re-activates ours when they were deactivated mid-session", async () => {
		const { pi, activeRef } = fakePi();
		const fetchImpl = mcpFetch({ "tools/list": () => IMAGE_TOOLS_LIST }, []);
		await registerImageTools(pi, { key: "lr_key", env: {}, version: "1.0.0", sessionId: "s", fetchImpl });
		pi.setActiveTools(pi.getActiveTools().filter((n) => n !== "generate_image"));
		expect(activeRef()).not.toContain("generate_image");
		await registerImageTools(pi, { key: "lr_key", env: {}, version: "1.0.0", sessionId: "s", fetchImpl });
		expect(activeRef()).toContain("generate_image");
		expect(pi.registerTool).toHaveBeenCalledTimes(3);
	});

	test("a throwing registration does not block the other tools; outcomes stay honest", async () => {
		const { pi, registered } = fakePi();
		const realRegister = pi.registerTool as unknown as (tool: { name: string }) => void;
		let calls = 0;
		(pi as unknown as { registerTool: (tool: { name: string }) => void }).registerTool = (tool) => {
			calls += 1;
			if (tool.name === "generate_image") throw new Error("boom");
			realRegister(tool);
		};
		const fetchImpl = mcpFetch({ "tools/list": () => IMAGE_TOOLS_LIST }, []);
		const registration = await registerImageTools(pi, { key: "lr_key", env: {}, version: "1.0.0", sessionId: "s", fetchImpl });
		expect(calls).toBe(3); // every tool attempted
		expect(registration).toMatchObject({ generateImage: "register-failed", editImage: "registered", uploadImage: "registered" });
		expect(registration.error).toContain("boom");
		expect(registered.map((t) => t.name).sort()).toEqual(["edit_image", "upload_image"]);
	});
});

describe("registerImageTools credential/schema freshness (roborev job 1640)", () => {
	beforeEach(() => {
		vi.unstubAllEnvs();
		_resetImageToolsState();
	});

	test("re-login with a rotated key: already-registered tools use the new client", async () => {
		const { pi, registered } = fakePi();
		const oldFetch = mcpFetch({ "tools/list": () => IMAGE_TOOLS_LIST }, []);
		const first = await registerImageTools(pi, { key: "lr_old", env: {}, version: "1.0.0", sessionId: "s", fetchImpl: oldFetch });
		expect(first.generateImage).toBe("registered");
		const generate = registered.find((t) => t.name === "generate_image");
		expect(generate).toBeDefined();

		// A logged-out gap or re-login builds a NEW client with a NEW key.
		const newFetch = mcpFetch(
			{
				"tools/list": () => IMAGE_TOOLS_LIST,
				"tools/call": () => ({
					content: [
						{ type: "text", text: GENERATED_TEXT },
						{ type: "image", data: Buffer.from("rotatedbytes").toString("base64"), mimeType: "image/png" },
					],
					isError: false,
				}),
			},
			[],
		);
		const second = await registerImageTools(pi, { key: "lr_rotated", env: {}, version: "1.0.0", sessionId: "s", fetchImpl: newFetch });
		expect(second.generateImage).toBe("registered");

		// The tool instance captured at FIRST registration must now talk
		// through the rotated client — same tool object, fresh credentials.
		const result = await generate!.execute("t1", { prompt: "p", model: "flux-2-klein" } as never, AC(), undefined, {} as never);
		expect((result.content[0] as { text?: string }).text).toContain("saved to:");
	});

	test("a changed server model enum re-registers the tool with the fresh schema", async () => {
		const { pi, registered } = fakePi();
		await registerImageTools(pi, { key: "lr_key", env: {}, version: "1.0.0", sessionId: "s", fetchImpl: mcpFetch({ "tools/list": () => IMAGE_TOOLS_LIST }, []) });
		expect(pi.registerTool).toHaveBeenCalledTimes(3);
		const withNewModel = {
			tools: IMAGE_TOOLS_LIST.tools.map((t) =>
				t.name === "generate_image"
					? { ...t, inputSchema: { type: "object", properties: { model: { type: "string", enum: ["flux-2-klein", "flux-2-dev"], description: "both" } } } }
					: t,
			),
		};
		await registerImageTools(pi, { key: "lr_key", env: {}, version: "1.0.0", sessionId: "s", fetchImpl: mcpFetch({ "tools/list": () => withNewModel }, []) });
		// generate_image was replaced (4 total registrations); the new schema
		// carries the refreshed enum.
		expect(pi.registerTool).toHaveBeenCalledTimes(4);
		const refreshed = registered.filter((t) => t.name === "generate_image");
		expect(refreshed).toHaveLength(2);
		const model = (refreshed[1]?.parameters as unknown as { properties: { model: { anyOf?: { const: string }[] } } }).properties.model;
		expect(model.anyOf).toEqual([
			{ type: "string", const: "flux-2-klein" },
			{ type: "string", const: "flux-2-dev" },
		]);
	});
});

describe("registerImageTools catalog drift reconciliation (roborev job 1643)", () => {
	beforeEach(() => {
		vi.unstubAllEnvs();
		_resetImageToolsState();
	});

	test("a tool the server no longer offers is deactivated on re-entry; ownership is kept", async () => {
		const { pi, activeRef } = fakePi();
		await registerImageTools(pi, { key: "lr_key", env: {}, version: "1.0.0", sessionId: "s", fetchImpl: mcpFetch({ "tools/list": () => IMAGE_TOOLS_LIST }, []) });
		expect(activeRef()).toContain("upload_image");

		const withoutUpload = { tools: IMAGE_TOOLS_LIST.tools.filter((t) => t.name !== "upload_image") };
		const second = await registerImageTools(pi, { key: "lr_key", env: {}, version: "1.0.0", sessionId: "s", fetchImpl: mcpFetch({ "tools/list": () => withoutUpload }, []) });
		expect(second).toMatchObject({ generateImage: "registered", uploadImage: "skipped-server" });
		expect(activeRef()).not.toContain("upload_image");
		expect(activeRef()).toContain("generate_image");

		// Ownership kept: a later re-offer re-activates (no re-registration —
		// and the ownership pre-check must not mistake it for a foreign tool).
		const third = await registerImageTools(pi, { key: "lr_key", env: {}, version: "1.0.0", sessionId: "s", fetchImpl: mcpFetch({ "tools/list": () => IMAGE_TOOLS_LIST }, []) });
		expect(third.uploadImage).toBe("registered");
		expect(activeRef()).toContain("upload_image");
	});
});

describe("upload_image local sniffing (roborev job 1646)", () => {
	const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
	const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]);
	const WEBP = Buffer.from([0x52, 0x49, 0x46, 0x46, 9, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 1]);

	test("rejects a non-image file before any bytes leave the machine", async () => {
		const client = fakeClient([{ type: "text", text: UPLOADED_TEXT }]);
		const io = memoryIo();
		io.files.set("/home/u/.aws/credentials", Buffer.from("[default]\naws_access_key_id=SECRET"));
		const tool = buildUploadImageTool({ client, mcpToolName: "upload_image", env: process.env, io });
		await expect(tool.execute("t1", { path: "/home/u/.aws/credentials" } as never, AC(), undefined, {} as never)).rejects.toThrow(/not a (png|jpeg|webp)/i);
		expect(client.callTool).not.toHaveBeenCalled();
	});

	test("accepts real image magic bytes (png/jpeg/webp) and declares the sniffed codec", async () => {
		for (const [name, bytes, mime] of [
			["png", PNG, "image/png"],
			["jpeg", JPEG, "image/jpeg"],
			["webp", WEBP, "image/webp"],
		] as const) {
			const client = fakeClient([{ type: "text", text: UPLOADED_TEXT }]);
			const io = memoryIo();
			io.files.set(`/home/u/cat.${name}`, bytes);
			const tool = buildUploadImageTool({ client, mcpToolName: "upload_image", env: process.env, io });
			await tool.execute("t1", { path: `/home/u/cat.${name}` } as never, AC(), undefined, {} as never);
			expect(client.callTool).toHaveBeenCalledWith("upload_image", { data: bytes.toString("base64"), mime_type: mime }, expect.anything());
		}
	});
});

describe("client swap ordering + superseded registrations (roborev job 1646)", () => {
	beforeEach(() => {
		vi.unstubAllEnvs();
		_resetImageToolsState();
	});

	test("a failed catalog fetch after key rotation still swaps tools to the new client", async () => {
		const { pi, registered } = fakePi();
		await registerImageTools(pi, { key: "lr_old", env: {}, version: "1.0.0", sessionId: "s", fetchImpl: mcpFetch({ "tools/list": () => IMAGE_TOOLS_LIST }, []) });
		const generate = registered.find((t) => t.name === "generate_image");

		// Rotated key + a catalog fetch that fails — the swap must happen anyway.
		const unreachable = vi.fn(async () => new Response("nope", { status: 503 }));
		const second = await registerImageTools(pi, { key: "lr_rotated", env: {}, version: "1.0.0", sessionId: "s", fetchImpl: unreachable });
		expect(second.generateImage).toBe("skipped-server");

		const calls = vi.fn(() => ({
			content: [
				{ type: "text", text: GENERATED_TEXT },
				{ type: "image", data: Buffer.from("pngbytes").toString("base64"), mimeType: "image/png" },
			],
			isError: false,
		}));
		const reachable = mcpFetch({ "tools/call": calls, "tools/list": () => IMAGE_TOOLS_LIST }, []);
		expect(calls).not.toHaveBeenCalled();
		const third = await registerImageTools(pi, { key: "lr_rotated", env: {}, version: "1.0.0", sessionId: "s", fetchImpl: reachable });
		expect(third.generateImage).toBe("registered");
		const result = await generate!.execute("t1", { prompt: "p", model: "flux-2-klein" } as never, AC(), undefined, {} as never);
		expect((result.content[0] as { text?: string }).text).toContain("saved to:");
	});

	test("a superseded registration never reconciles away a newer registration's tools", async () => {
		const { pi, activeRef } = fakePi();
		// Registration A: hangs on tools/list; resolves only after B finished.
		let resolveA: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			resolveA = resolve;
		});
		const hangingFetch = mcpFetch(
			{
				"tools/list": () => {
					void gate;
					throw new Error("simulated hang — never returned");
				},
			},
			[],
		);
		// An actually-deferred listTools: build a custom fetch that awaits the gate.
		const withoutUpload = { tools: IMAGE_TOOLS_LIST.tools.filter((t) => t.name !== "upload_image") };
		const deferredFetch = async (_url: string, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body)) as { id: number; method: string };
			if (body.method === "tools/list") {
				await gate;
				return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: withoutUpload }), { status: 200, headers: { "content-type": "application/json" } });
			}
			return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} }), { status: 200, headers: { "content-type": "application/json" } });
		};
		void hangingFetch;
		const a = registerImageTools(pi, { key: "lr_key", env: {}, version: "1.0.0", sessionId: "s", fetchImpl: deferredFetch as never });
		// Give A a head start into its await, then run B to completion.
		await Promise.resolve();
		await registerImageTools(pi, { key: "lr_key", env: {}, version: "1.0.0", sessionId: "s", fetchImpl: mcpFetch({ "tools/list": () => IMAGE_TOOLS_LIST }, []) });
		expect(activeRef()).toContain("upload_image");
		// A's (older) catalog resolves now — it lists upload_image too, but the
		// point is the guard: A must not mutate anything after being superseded.
		resolveA();
		await a;
		expect(activeRef()).toContain("upload_image");
	});
});

describe("server-id validation + disable-during-discovery (roborev job 1649)", () => {
	beforeEach(() => {
		vi.unstubAllEnvs();
		_resetImageToolsState();
	});

	test("a server-provided id with path segments never escapes the images dir", async () => {
		const evil = GENERATED_TEXT.replace(
			"id: img_01JD2W3Q4R5T6Y7U8I9O0P1A2B",
			"id: ../../../home/u/.bashrc",
		);
		const client = fakeClient([
			{ type: "text", text: evil },
			{ type: "image", data: Buffer.from("pngbytes").toString("base64"), mimeType: "image/png" },
		]);
		const io = memoryIo();
		vi.stubEnv("PI_CODING_AGENT_DIR", "/tmp/agent");
		const tool = buildGenerateImageTool({ client, mcpToolName: "generate_image", env: process.env, io });
		const result = await tool.execute("t1", { prompt: "p", model: "m" } as never, AC(), undefined, {} as never);
		expect(io.files.size).toBe(0); // nothing written anywhere
		expect((result.content[0] as { text?: string }).text).toContain("not saved locally");
	});

	test("toggling the setting off while discovery is in flight supersedes the registration", async () => {
		const { pi, activeRef } = fakePi();
		let resolveA: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			resolveA = resolve;
		});
		const deferredFetch = async (_url: string, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body)) as { id: number; method: string };
			if (body.method === "tools/list") {
				await gate;
				return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: IMAGE_TOOLS_LIST }), { status: 200, headers: { "content-type": "application/json" } });
			}
			return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} }), { status: 200, headers: { "content-type": "application/json" } });
		};
		const a = registerImageTools(pi, { key: "lr_key", env: {}, version: "1.0.0", sessionId: "s", fetchImpl: deferredFetch as never });
		await Promise.resolve();
		// The user disables image tools while the catalog fetch is in flight.
		const off = await registerImageTools(pi, {
			key: "lr_key", env: {}, version: "1.0.0", sessionId: "s", fetchImpl: deferredFetch as never,
			settings: { mcp: "on", webTools: "on", searchProvider: "server", imageTools: "off" },
		});
		expect(off.generateImage).toBe("skipped-disabled");
		resolveA();
		const outcome = await a;
		expect(outcome.generateImage).toBe("skipped-server");
		expect(outcome.error).toContain("superseded");
		expect(activeRef()).not.toContain("generate_image");
	});
});

describe("foreign same-named tools + upload TOCTOU (roborev job 1651)", () => {
	beforeEach(() => {
		vi.unstubAllEnvs();
		_resetImageToolsState();
	});

	test("a foreign same-named tool is neither registered, tracked, nor ever toggled by us", async () => {
		const { pi, registered, activeRef } = fakePi({ foreignTools: ["generate_image"] });
		const first = await registerImageTools(pi, { key: "lr_key", env: {}, version: "1.0.0", sessionId: "s", fetchImpl: mcpFetch({ "tools/list": () => IMAGE_TOOLS_LIST }, []) });
		expect(first).toMatchObject({ generateImage: "skipped-existing", editImage: "registered", uploadImage: "registered" });
		expect(registered.map((t) => t.name).sort()).toEqual(["edit_image", "upload_image"]);
		// The foreign tool stays active and untouched.
		expect(activeRef()).toContain("generate_image");

		// Catalog drift must not deactivate the foreign tool either.
		const withoutGenerate = { tools: IMAGE_TOOLS_LIST.tools.filter((t) => t.name !== "generate_image") };
		await registerImageTools(pi, { key: "lr_key", env: {}, version: "1.0.0", sessionId: "s", fetchImpl: mcpFetch({ "tools/list": () => withoutGenerate }, []) });
		expect(activeRef()).toContain("generate_image");
		expect(activeRef()).toContain("edit_image");
	});

	test("a file that grows between stat and read is still rejected", async () => {
		const client = fakeClient([{ type: "text", text: UPLOADED_TEXT }]);
		const io = memoryIo();
		io.files.set("/home/u/grew.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
		const big = new Uint8Array(UPLOAD_MAX_BYTES + 1);
		big.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		io.readFileBounded = async () => big; // the file grew — the read returns more than the ceiling
		const tool = buildUploadImageTool({ client, mcpToolName: "upload_image", env: process.env, io });
		await expect(tool.execute("t1", { path: "/home/u/grew.png" } as never, AC(), undefined, {} as never)).rejects.toThrow(/11 MiB/);
		expect(client.callTool).not.toHaveBeenCalled();
	});
});

describe("upload url scheme validation + download abort (roborev job 1656)", () => {
	test("non-http(s) upload urls are rejected locally before the MCP call", async () => {
		const client = fakeClient([{ type: "text", text: UPLOADED_TEXT }]);
		const tool = buildUploadImageTool({ client, mcpToolName: "upload_image", env: process.env, io: memoryIo() });
		for (const bad of ["file:///etc/passwd", "data:image/png;base64,AAAA", "ftp://example.com/cat.png", "not a url"]) {
			await expect(tool.execute("t1", { url: bad } as never, AC(), undefined, {} as never)).rejects.toThrow(/http\(s\)|valid URL/i);
		}
		expect(client.callTool).not.toHaveBeenCalled();
	});

	test("the signed-url download receives the execution abort signal", async () => {
		const client = fakeClient([{ type: "text", text: GENERATED_TEXT }]); // embed dropped → URL fetch
		let seenSignal: AbortSignal | undefined;
		const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
			seenSignal = init?.signal ?? undefined;
			return new Response("bytes", { status: 200 });
		});
		vi.stubEnv("PI_CODING_AGENT_DIR", "/tmp/agent");
		const tool = buildGenerateImageTool({ client, mcpToolName: "generate_image", env: process.env, io: memoryIo(), fetchImpl });
		const controller = new AbortController();
		await tool.execute("t1", { prompt: "p", model: "m" } as never, controller.signal, undefined, {} as never);
		expect(seenSignal).toBe(controller.signal);
	});
});

describe("bounded upload read (roborev job 1659)", () => {
	test("a huge swapped file is never fully read — the read is capped at the ceiling", async () => {
		const client = fakeClient([{ type: "text", text: UPLOADED_TEXT }]);
		const io = memoryIo();
		// A file far larger than any image: 64 MiB of PNG-magic bytes.
		const huge = Buffer.alloc(64 * 1024 * 1024);
		huge.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		io.files.set("/home/u/huge.png", huge);
		let maxRequested = 0;
		const origBounded = io.readFileBounded.bind(io);
		io.readFileBounded = async (path, maxBytes) => {
			maxRequested = Math.max(maxRequested, maxBytes);
			return origBounded(path, maxBytes);
		};
		const tool = buildUploadImageTool({ client, mcpToolName: "upload_image", env: process.env, io });
		await expect(tool.execute("t1", { path: "/home/u/huge.png" } as never, AC(), undefined, {} as never)).rejects.toThrow(/11 MiB/);
		expect(maxRequested).toBe(UPLOAD_MAX_BYTES + 1); // never asked for more
		expect(client.callTool).not.toHaveBeenCalled();
	});
});

describe("abort-aware save (roborev job 1661)", () => {
	test("aborting after the download completes writes nothing", async () => {
		const client = fakeClient([{ type: "text", text: GENERATED_TEXT }]); // embed dropped → URL fetch
		const controller = new AbortController();
		const fetchImpl = vi.fn(async () => {
			controller.abort(); // cancelled after the download resolved
			return new Response("bytes", { status: 200 });
		});
		const io = memoryIo();
		vi.stubEnv("PI_CODING_AGENT_DIR", "/tmp/agent");
		const tool = buildGenerateImageTool({ client, mcpToolName: "generate_image", env: process.env, io, fetchImpl });
		const result = await tool.execute("t1", { prompt: "p", model: "m" } as never, controller.signal, undefined, {} as never);
		expect(io.files.size).toBe(0); // nothing written
		expect((result.content[0] as { text?: string }).text).toContain("not saved locally");
	});

	test("aborting before the save skips it even with inline bytes", async () => {
		const client = fakeClient([
			{ type: "text", text: GENERATED_TEXT },
			{ type: "image", data: Buffer.from("pngbytes").toString("base64"), mimeType: "image/png" },
		]);
		const controller = new AbortController();
		controller.abort();
		const io = memoryIo();
		vi.stubEnv("PI_CODING_AGENT_DIR", "/tmp/agent");
		const tool = buildGenerateImageTool({ client, mcpToolName: "generate_image", env: process.env, io });
		const result = await tool.execute("t1", { prompt: "p", model: "m" } as never, controller.signal, undefined, {} as never);
		expect(io.files.size).toBe(0);
		expect((result.content[0] as { text?: string }).text).toContain("not saved locally");
	});
});

describe("bounded read loop (roborev job 1663)", () => {
	// readOnce that short-reads in 3-byte chunks — FileHandle.read may do this.
	function shortReadingFile(content: Uint8Array) {
		return async (buffer: Uint8Array, offset: number, length: number, position: number): Promise<number> => {
			const take = Math.min(3, length); // never fills the request in one go
			for (let i = 0; i < take && position + i < content.length; i++) {
				buffer[offset + i] = content[position + i];
			}
			return Math.max(0, Math.min(take, content.length - position));
		};
	}

	test("collects the whole file across short reads, up to the limit", async () => {
		const content = new Uint8Array(10);
		for (let i = 0; i < content.length; i++) content[i] = i;
		const full = await readUntilLimit(shortReadingFile(content), 100);
		expect(Array.from(full)).toEqual(Array.from(content)); // all 10 bytes
		const capped = await readUntilLimit(shortReadingFile(content), 8);
		expect(capped.length).toBe(8); // the bound holds
		expect(Array.from(capped)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
	});

	test("EOF (zero-byte read) stops the loop", async () => {
		let calls = 0;
		const eofFile = async (): Promise<number> => {
			calls += 1;
			return 0;
		};
		const out = await readUntilLimit(eofFile, 100);
		expect(out.length).toBe(0);
		expect(calls).toBe(1); // stopped immediately at EOF
	});
});

describe("atomic save (roborev job 1665)", () => {
	test("aborting during the write leaves neither the image nor a temp file", async () => {
		const client = fakeClient([
			{ type: "text", text: GENERATED_TEXT },
			{ type: "image", data: Buffer.from("pngbytes").toString("base64"), mimeType: "image/png" },
		]);
		const controller = new AbortController();
		const io = memoryIo();
		const origWrite = io.writeFile.bind(io);
		io.writeFile = async (path, data) => {
			await origWrite(path, data); // the temp file lands on disk
			controller.abort(); // cancellation arrives mid-write
		};
		vi.stubEnv("PI_CODING_AGENT_DIR", "/tmp/agent");
		const tool = buildGenerateImageTool({ client, mcpToolName: "generate_image", env: process.env, io });
		const result = await tool.execute("t1", { prompt: "p", model: "m" } as never, controller.signal, undefined, {} as never);
		expect(io.files.size).toBe(0); // no final image, no leftover temp
		expect((result.content[0] as { text?: string }).text).toContain("not saved locally");
	});

	test("a failed rename cleans the temp file and reports not-saved", async () => {
		const client = fakeClient([
			{ type: "text", text: GENERATED_TEXT },
			{ type: "image", data: Buffer.from("pngbytes").toString("base64"), mimeType: "image/png" },
		]);
		const io = memoryIo();
		io.rename = async () => {
			throw new Error("disk full");
		};
		vi.stubEnv("PI_CODING_AGENT_DIR", "/tmp/agent");
		const tool = buildGenerateImageTool({ client, mcpToolName: "generate_image", env: process.env, io });
		const result = await tool.execute("t1", { prompt: "p", model: "m" } as never, AC(), undefined, {} as never);
		expect(io.files.size).toBe(0); // temp cleaned, nothing final
		expect((result.content[0] as { text?: string }).text).toContain("not saved locally");
	});
});

describe("post-rename cancellation (roborev job 1667)", () => {
	test("aborting during the rename removes the final image too", async () => {
		const client = fakeClient([
			{ type: "text", text: GENERATED_TEXT },
			{ type: "image", data: Buffer.from("pngbytes").toString("base64"), mimeType: "image/png" },
		]);
		const controller = new AbortController();
		const io = memoryIo();
		io.rename = async (from, to) => {
			controller.abort(); // cancellation lands while the rename is in flight
			const data = io.files.get(from);
			io.files.delete(from);
			if (data) io.files.set(to, data);
		};
		vi.stubEnv("PI_CODING_AGENT_DIR", "/tmp/agent");
		const tool = buildGenerateImageTool({ client, mcpToolName: "generate_image", env: process.env, io });
		const result = await tool.execute("t1", { prompt: "p", model: "m" } as never, controller.signal, undefined, {} as never);
		expect(io.files.size).toBe(0); // neither the final image nor the temp remains
		expect((result.content[0] as { text?: string }).text).toContain("not saved locally");
	});
});
