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
