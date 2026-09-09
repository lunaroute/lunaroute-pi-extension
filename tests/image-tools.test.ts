import { beforeEach, describe, expect, test, vi } from "vitest";
import {
	_resetImageToolsState,
	parseImageResultText,
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
		stat: async (path) => ({ size: files.get(path)?.length ?? 0 }),
		readFile: async (path) => files.get(path) ?? new Uint8Array(),
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
		io.files.set("/home/u/cat.png", Buffer.from("catpng"));
		const tool = buildUploadImageTool({ client, mcpToolName: "upload_image", env: process.env, io });
		const result = await tool.execute("t1", { path: "/home/u/cat.png" } as never, AC(), undefined, {} as never);
		expect(client.callTool).toHaveBeenCalledWith("upload_image", { data: Buffer.from("catpng").toString("base64") }, expect.anything());
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

function fakePi() {
	const registered: ToolDefinition<never, never>[] = [];
	let active: string[] = ["read", "bash"];
	const pi = {
		registerTool: vi.fn((tool: ToolDefinition<never, never>) => registered.push(tool)),
		getActiveTools: () => [...active],
		setActiveTools: (names: string[]) => {
			active = [...names];
		},
		getAllTools: () => registered.map((t) => ({ name: t.name })),
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

	test("a tool the server no longer offers is deactivated and untracked on re-entry", async () => {
		const { pi, activeRef } = fakePi();
		await registerImageTools(pi, { key: "lr_key", env: {}, version: "1.0.0", sessionId: "s", fetchImpl: mcpFetch({ "tools/list": () => IMAGE_TOOLS_LIST }, []) });
		expect(activeRef()).toContain("upload_image");

		const withoutUpload = { tools: IMAGE_TOOLS_LIST.tools.filter((t) => t.name !== "upload_image") };
		const second = await registerImageTools(pi, { key: "lr_key", env: {}, version: "1.0.0", sessionId: "s", fetchImpl: mcpFetch({ "tools/list": () => withoutUpload }, []) });
		expect(second).toMatchObject({ generateImage: "registered", uploadImage: "skipped-server" });
		expect(activeRef()).not.toContain("upload_image");
		expect(activeRef()).toContain("generate_image");

		// Untracked means a later re-offer registers it fresh.
		const third = await registerImageTools(pi, { key: "lr_key", env: {}, version: "1.0.0", sessionId: "s", fetchImpl: mcpFetch({ "tools/list": () => IMAGE_TOOLS_LIST }, []) });
		expect(third.uploadImage).toBe("registered");
		expect(activeRef()).toContain("upload_image");
	});
});
