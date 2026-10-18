import { beforeEach, describe, expect, test } from "vitest";
import {
	_resetInsightsState,
	emptyStats,
	isInsightsOn,
	parseQueueMs,
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
