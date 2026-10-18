import { beforeEach, describe, expect, test } from "vitest";
import type { LunarouteMcpClient } from "../src/web-tools.js";
import {
	_resetInsightsState,
	emptyStats,
	fetchUsage,
	isInsightsOn,
	parseQueueMs,
	parseUsageSnapshot,
	recordQueueWait,
	setInsightsOn,
} from "../src/usage.js";

describe("parseQueueMs", () => {
	test("reads an integer millisecond value", () => {
		expect(parseQueueMs({ "x-lunaroute-queue-ms": "1420" })).toBe(1420);
	});

	test("returns undefined when the header is absent", () => {
		expect(parseQueueMs({ "content-type": "text/event-stream" })).toBeUndefined();
	});

	test("ignores non-numeric, negative and absurd values", () => {
		expect(parseQueueMs({ "x-lunaroute-queue-ms": "abc" })).toBeUndefined();
		expect(parseQueueMs({ "x-lunaroute-queue-ms": "-5" })).toBeUndefined();
		expect(parseQueueMs({ "x-lunaroute-queue-ms": "1.5" })).toBeUndefined();
		expect(parseQueueMs({ "x-lunaroute-queue-ms": "999999999999999" })).toBeUndefined();
	});

	test("accepts zero (admitted immediately)", () => {
		expect(parseQueueMs({ "x-lunaroute-queue-ms": "0" })).toBe(0);
	});

	test("a header name of another provider is ignored", () => {
		expect(parseQueueMs({ "x-lunaroute-queue": "12" })).toBeUndefined();
	});
});

describe("recordQueueWait", () => {
	test("accumulates count, total, max and last", () => {
		let s = emptyStats();
		s = recordQueueWait(s, 100);
		s = recordQueueWait(s, 20);
		expect(s).toEqual({ requests: 2, totalMs: 120, maxMs: 100, lastMs: 20 });
	});

	test("emptyStats is all zero", () => {
		expect(emptyStats()).toEqual({ requests: 0, totalMs: 0, maxMs: 0, lastMs: 0 });
	});
});

describe("insights gate", () => {
	beforeEach(() => {
		_resetInsightsState();
	});

	test("defaults off until something sets it", () => {
		expect(isInsightsOn()).toBe(false);
	});

	test("setInsightsOn toggles the shared gate", () => {
		setInsightsOn(true);
		expect(isInsightsOn()).toBe(true);
		setInsightsOn(false);
		expect(isInsightsOn()).toBe(false);
	});
});

const VALID_SNAPSHOT = {
	plan: { id: "pro", name: "Pro", interactiveLanes: 4, backgroundLanes: 0 },
	period: { start: "2026-10-01T00:00:00Z", end: "2026-10-31T00:00:00Z" },
	totals: { requests: 812, queuedMs: 482000, requestMs: 1900000, rejected: 3, rejectQueuedMs: 142000 },
	status: "elevated",
	suggestedAction: {
		kind: "add_lanes",
		url: "https://app.lunaroute.com/settings/billing",
		message: "Add a lane",
	},
} as const;

function fakeClient(result: { text?: string; throws?: boolean }): LunarouteMcpClient {
	return {
		listTools: async () => [],
		callTool: async () => {
			if (result.throws) throw new Error("MCP tools/call failed: HTTP 500");
			return { content: [{ type: "text", text: result.text }] };
		},
	};
}

describe("fetchUsage", () => {
	test("parses a well-formed get_usage result", async () => {
		const client = fakeClient({ text: JSON.stringify(VALID_SNAPSHOT) });
		await expect(fetchUsage(client)).resolves.toEqual(VALID_SNAPSHOT);
	});

	test("returns undefined when the tool errors or is absent", async () => {
		await expect(fetchUsage(fakeClient({ throws: true }))).resolves.toBeUndefined();
	});

	test("returns undefined on malformed or empty payloads", async () => {
		await expect(fetchUsage(fakeClient({ text: "not json" }))).resolves.toBeUndefined();
		await expect(fetchUsage(fakeClient({ text: "" }))).resolves.toBeUndefined();
		await expect(fetchUsage(fakeClient({ text: '{"status":"weird"}' }))).resolves.toBeUndefined();
	});

	test("forwards the abort signal to the MCP call", async () => {
		const controller = new AbortController();
		let seen: AbortSignal | undefined;
		const client: LunarouteMcpClient = {
			listTools: async () => [],
			callTool: async (_name, _args, signal) => {
				seen = signal;
				return { content: [{ type: "text", text: JSON.stringify(VALID_SNAPSHOT) }] };
			},
		};
		await fetchUsage(client, controller.signal);
		expect(seen).toBe(controller.signal);
	});

	test("drops a malformed suggestedAction without rejecting the snapshot", () => {
		expect(parseUsageSnapshot({ ...VALID_SNAPSHOT, suggestedAction: null })?.suggestedAction).toBeUndefined();
		expect(
			parseUsageSnapshot({ ...VALID_SNAPSHOT, suggestedAction: { kind: "bogus", url: 1 } })?.suggestedAction,
		).toBeUndefined();
	});

	test("treats null lane fields as absent", () => {
		const parsed = parseUsageSnapshot({
			...VALID_SNAPSHOT,
			plan: { id: "pro", name: "Pro", interactiveLanes: null, backgroundLanes: null },
		});
		expect(parsed?.plan).toEqual({ id: "pro", name: "Pro" });
	});
});
