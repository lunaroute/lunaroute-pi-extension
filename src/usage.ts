/** Usage insights: per-request queue time collected from the gateway's
 * `x-lunaroute-queue-ms` response header, plus a process-wide gate shared by
 * the response hook and the settings applier.
 *
 * Collection is deliberately cheap and fail-open: a missing, malformed or
 * absurd header is ignored, and nothing here ever throws into a request.
 */

/** Ceiling for a plausible queue wait — one hour. Anything larger is a corrupt
 * value, not a real park (the gate's own deadline ceiling is minutes). */
const MAX_QUEUE_MS = 60 * 60 * 1000;

/** Integer milliseconds from `x-lunaroute-queue-ms`, or undefined. */
export function parseQueueMs(headers: Record<string, string>): number | undefined {
	const raw = headers["x-lunaroute-queue-ms"];
	if (typeof raw !== "string" || !/^\d+$/.test(raw)) return undefined;
	const ms = Number(raw);
	return ms <= MAX_QUEUE_MS ? ms : undefined;
}

export interface SessionQueueStats {
	requests: number;
	totalMs: number;
	maxMs: number;
	lastMs: number;
}

export function emptyStats(): SessionQueueStats {
	return { requests: 0, totalMs: 0, maxMs: 0, lastMs: 0 };
}

/** Immutable accumulate: returns a new stats object. */
export function recordQueueWait(stats: SessionQueueStats, ms: number): SessionQueueStats {
	return {
		requests: stats.requests + 1,
		totalMs: stats.totalMs + ms,
		maxMs: Math.max(stats.maxMs, ms),
		lastMs: ms,
	};
}

// Process-wide gate: `index.ts` refreshes it at session_start and the settings
// applier updates it on a toggle. Keeping it here (rather than in index.ts)
// lets both sides share one value without callback plumbing.
let insightsOn = false;

export function setInsightsOn(on: boolean): void {
	insightsOn = on;
}

export function isInsightsOn(): boolean {
	return insightsOn;
}

/** Test-only: restore the module default. */
export function _resetInsightsState(): void {
	insightsOn = false;
}

import type { LunarouteMcpClient } from "./web-tools.js";

// ============================================================================
// Aggregate usage snapshot (server `get_usage` tool)
// ============================================================================

export type UsageStatus = "ok" | "elevated" | "saturated" | "unknown";

const USAGE_STATUSES: readonly UsageStatus[] = ["ok", "elevated", "saturated", "unknown"];
const ACTION_KINDS = ["none", "add_lanes", "upgrade_plan"] as const;

export interface UsageSnapshot {
	plan: { id: string; name: string; interactiveLanes?: number; backgroundLanes?: number };
	period: { start: string; end: string };
	totals: { requests: number; queuedMs: number; requestMs: number; rejected: number; rejectQueuedMs: number };
	status: UsageStatus;
	suggestedAction?: { kind: (typeof ACTION_KINDS)[number]; url?: string; message?: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Optional lane count: a number, or absent. `null` is treated as absent (the
 * server omits unavailable lanes; tolerate a null without rejecting the whole
 * snapshot). */
function laneCount(value: unknown): number | undefined {
	return finiteNumber(value);
}

function parseAction(value: unknown): UsageSnapshot["suggestedAction"] {
	if (!isRecord(value)) return undefined;
	const kind = ACTION_KINDS.find((k) => k === value.kind);
	if (!kind) return undefined;
	const action: NonNullable<UsageSnapshot["suggestedAction"]> = { kind };
	if (typeof value.url === "string") action.url = value.url;
	if (typeof value.message === "string") action.message = value.message;
	return action;
}

/** Validate a raw `get_usage` payload into a snapshot, or undefined when the
 * core shape is wrong. Extra fields are dropped; a malformed `suggestedAction`
 * is dropped alone (the numbers are still useful). */
export function parseUsageSnapshot(raw: unknown): UsageSnapshot | undefined {
	if (!isRecord(raw)) return undefined;
	const status = USAGE_STATUSES.find((s) => s === raw.status);
	const plan = raw.plan;
	const period = raw.period;
	const totals = raw.totals;
	if (!status || !isRecord(plan) || !isRecord(period) || !isRecord(totals)) return undefined;
	if (typeof plan.id !== "string" || typeof plan.name !== "string") return undefined;
	if (typeof period.start !== "string" || typeof period.end !== "string") return undefined;

	const requests = finiteNumber(totals.requests);
	const queuedMs = finiteNumber(totals.queuedMs);
	const requestMs = finiteNumber(totals.requestMs);
	const rejected = finiteNumber(totals.rejected);
	const rejectQueuedMs = finiteNumber(totals.rejectQueuedMs);
	if (requests === undefined || queuedMs === undefined || requestMs === undefined || rejected === undefined || rejectQueuedMs === undefined) {
		return undefined;
	}

	const parsedPlan: UsageSnapshot["plan"] = { id: plan.id, name: plan.name };
	const interactive = laneCount(plan.interactiveLanes);
	const background = laneCount(plan.backgroundLanes);
	if (interactive !== undefined) parsedPlan.interactiveLanes = interactive;
	if (background !== undefined) parsedPlan.backgroundLanes = background;

	const snapshot: UsageSnapshot = {
		plan: parsedPlan,
		period: { start: period.start, end: period.end },
		totals: { requests, queuedMs, requestMs, rejected, rejectQueuedMs },
		status,
	};
	const action = parseAction(raw.suggestedAction);
	if (action) snapshot.suggestedAction = action;
	return snapshot;
}

/** Call the server's `get_usage` tool and parse its text payload. Never throws:
 * any transport, tool or shape failure resolves to undefined (fail-open). */
export async function fetchUsage(
	client: LunarouteMcpClient,
	signal?: AbortSignal,
): Promise<UsageSnapshot | undefined> {
	try {
		const result = await client.callTool("get_usage", {}, signal);
		const text = (result.content ?? []).map((c) => c.text ?? "").join("\n").trim();
		if (!text) return undefined;
		return parseUsageSnapshot(JSON.parse(text));
	} catch {
		return undefined;
	}
}

// ============================================================================
// Presentation
// ============================================================================

/** Compact duration: 482000 → "8m 2s", 1500 → "1s", 840 → "840 ms". */
export function formatMs(ms: number): string {
	if (ms >= 60_000) {
		const minutes = Math.floor(ms / 60_000);
		const seconds = Math.floor((ms % 60_000) / 1000);
		return `${minutes}m ${seconds}s`;
	}
	if (ms >= 1000) return `${Math.floor(ms / 1000)}s`;
	return `${ms} ms`;
}

/** One human-readable usage report for `/lunaroute usage`. Renders the plan,
 * period, totals and status when a snapshot is available; always renders the
 * session's own measured queueing, which is all we have when the server tool
 * is unavailable. */
export function formatUsageReport(snapshot: UsageSnapshot | undefined, stats: SessionQueueStats): string {
	const lines: string[] = [];
	if (!snapshot) {
		lines.push("LunaRoute usage unavailable (server usage tool not reachable).");
	} else {
		const lanes = snapshot.plan.interactiveLanes;
		const planLine = lanes === undefined ? `Plan: ${snapshot.plan.name}` : `Plan: ${snapshot.plan.name} — ${lanes} lanes`;
		lines.push(planLine);
		lines.push(
			`Period: ${snapshot.period.start.slice(0, 10)} to ${snapshot.period.end.slice(0, 10)}`,
		);
		lines.push(
			`${snapshot.totals.requests} requests — ${formatMs(snapshot.totals.queuedMs)} queued, ${snapshot.totals.rejected} rejected (${formatMs(snapshot.totals.rejectQueuedMs)} queued before rejection)`,
		);
		lines.push(`Status: ${snapshot.status}`);
		if (snapshot.suggestedAction?.url) lines.push(`More: ${snapshot.suggestedAction.url}`);
	}
	if (stats.requests === 0) {
		lines.push("this session: no queued responses measured");
	} else {
		const avg = Math.round(stats.totalMs / stats.requests);
		lines.push(
			`this session: ${stats.requests} requests, ${stats.totalMs} ms queued, avg ${avg} ms, max ${stats.maxMs} ms`,
		);
	}
	return lines.join("\n");
}

const BUILTIN_NUDGE: Record<"elevated" | "saturated", string> = {
	elevated: "LunaRoute is queueing your requests — run /lunaroute usage for details.",
	saturated: "LunaRoute is queueing your requests heavily — run /lunaroute usage for details.",
};

/** The proactive notice text, or undefined when nothing should be shown.
 * The server owns the wording when it supplies one. */
export function nudgeMessage(snapshot: UsageSnapshot): string | undefined {
	if (snapshot.status !== "elevated" && snapshot.status !== "saturated") return undefined;
	const authored = snapshot.suggestedAction?.message;
	return authored || BUILTIN_NUDGE[snapshot.status];
}
