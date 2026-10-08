/**
 * Auto Compact — threshold based automatic compaction for pi.
 *
 * Compacts the session as soon as the context reaches a configured limit:
 *
 *   percent — context usage as a % of the active model's context window
 *   tokens  — absolute context length in tokens
 *
 * Both limits are honored at the same time and the *smaller* one wins:
 *
 *   compact when contextTokens >= min(percent% * contextWindow, tokens)
 *
 * Configuration, highest precedence first:
 *   1. CLI flags  pi --autocompact-percent 70 --autocompact-tokens 150000
 *   2. Env vars   PI_AUTOCOMPACT_PERCENT / PI_AUTOCOMPACT_TOKENS / PI_AUTOCOMPACT=0
 *   3. Project    <cwd>/.pi/autocompact.json   (only when the project is trusted)
 *   4. Global     ~/.pi/agent/autocompact.json
 *   5. Defaults   percent 75, tokens off
 *
 * autocompact.json is plain JSON, values are used as-is:
 *   {
 *     "enabled": true,
 *     "percent": 70,        // null disables this limit
 *     "tokens": 150000      // null disables this limit
 *   }
 *
 * `/autocompact` reads the current state and writes the global file directly:
 *   /autocompact              show the current limits and usage
 *   /autocompact on|off       enable/disable
 *   /autocompact percent 70   context % threshold (or "off")
 *   /autocompact tokens 150000
 *
 * Compaction happens when an agent run has fully finished (pi's agent_settled
 * event), so a run in flight is never interrupted. Opening a session or switching
 * models never compacts by itself, even when already over the limit: the check
 * waits until the next run finishes. A session that is still over the limit right
 * after a compaction waits for the next run, and at least
 * MIN_TURNS_BETWEEN_COMPACTIONS turns, before it is compacted again.
 *
 * Print/JSON (headless) runs are skipped: pi exits right after the prompt.
 */

import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const CONFIG_FILE = "autocompact.json";

/** Never compact more often than this many turns apart (guards against compaction storms). */
const MIN_TURNS_BETWEEN_COMPACTIONS = 2;
/** Back off for this long after a failed compaction before trying again. */
const FAILURE_RETRY_DELAY_MS = 60_000;
/** Treat an in-flight compaction as stale after this long (e.g. cancelled by another extension). */
const COMPACTION_STALE_MS = 10 * 60_000;

interface EffectiveConfig {
	enabled: boolean;
	percent: number | null;
	tokens: number | null;
}

/** Whatever a single configuration layer specifies. null (or 0) turns a limit off. */
type RawConfig = Partial<EffectiveConfig>;

const DEFAULTS: EffectiveConfig = { enabled: true, percent: 75, tokens: null };

function formatTokens(tokens: number): string {
	if (tokens >= 1_000_000) return `${round(tokens / 1_000_000)}M`;
	if (tokens >= 1_000) return `${round(tokens / 1_000)}k`;
	return String(tokens);
}

function round(value: number): number {
	return value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
}

export default function autoCompactExtension(pi: ExtensionAPI): void {
	let compactingSince: number | undefined;
	let armed = true;
	let turnsSinceCompaction = Number.POSITIVE_INFINITY;
	let retryBlockedUntil = 0;

	// -------------------------------------------------------------------------
	// Configuration
	// -------------------------------------------------------------------------

	/** A missing file means "not configured"; a malformed file throws. */
	const readConfig = (path: string): RawConfig =>
		existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as RawConfig) : {};

	/** CLI flags and env vars are strings, and may hold anything. */
	const number = (value: boolean | string | undefined): number | undefined => {
		const parsed = typeof value === "string" ? Number(value) : Number.NaN;
		return Number.isNaN(parsed) ? undefined : parsed;
	};

	const resolveConfig = (ctx: ExtensionContext): EffectiveConfig => {
		const layers: RawConfig[] = [
			readConfig(join(getAgentDir(), CONFIG_FILE)),
			ctx.isProjectTrusted() ? readConfig(join(ctx.cwd, CONFIG_DIR_NAME, CONFIG_FILE)) : {},
			{
				enabled: process.env.PI_AUTOCOMPACT === undefined ? undefined : process.env.PI_AUTOCOMPACT !== "0",
				percent: number(process.env.PI_AUTOCOMPACT_PERCENT),
				tokens: number(process.env.PI_AUTOCOMPACT_TOKENS),
			},
			{
				enabled: pi.getFlag("autocompact-off") === true ? false : undefined,
				percent: number(pi.getFlag("autocompact-percent")),
				tokens: number(pi.getFlag("autocompact-tokens")),
			},
		];

		const config = { ...DEFAULTS };
		for (const layer of layers) {
			if (layer.enabled !== undefined) config.enabled = layer.enabled;
			if (layer.percent !== undefined) config.percent = layer.percent;
			if (layer.tokens !== undefined) config.tokens = layer.tokens;
		}
		return config;
	};

	/** /autocompact writes here, so the setting survives the session. */
	const writeConfig = (patch: RawConfig): void => {
		const path = join(getAgentDir(), CONFIG_FILE);
		writeFileSync(path, `${JSON.stringify({ ...readConfig(path), ...patch }, null, 2)}\n`, "utf8");
	};

	/** min(percent% × contextWindow, tokens) — the smaller configured limit wins. */
	const effectiveLimit = (
		config: EffectiveConfig,
		contextWindow: number | undefined,
	): { limit: number; label: string } | undefined => {
		const window = contextWindow ?? 0;
		const limits: { limit: number; label: string }[] = [];
		if (config.percent !== null && config.percent > 0 && window > 0) {
			limits.push({
				limit: Math.floor((window * config.percent) / 100),
				label: `${config.percent}% of ${formatTokens(window)}`,
			});
		}
		if (config.tokens) {
			limits.push({ limit: config.tokens, label: `${formatTokens(config.tokens)} tokens` });
		}
		const usable = limits.filter((entry) => entry.limit > 0);
		return usable.length === 0 ? undefined : usable.reduce((a, b) => (a.limit <= b.limit ? a : b));
	};

	// -------------------------------------------------------------------------
	// Compaction trigger
	// -------------------------------------------------------------------------

	const clearCompacting = (): void => {
		compactingSince = undefined;
	};

	const isCompacting = (): boolean => {
		if (compactingSince === undefined) return false;
		if (Date.now() - compactingSince > COMPACTION_STALE_MS) {
			// A compaction that never reported back (cancelled elsewhere, session torn
			// down...): stop blocking and let the limit decide again.
			clearCompacting();
			return false;
		}
		return true;
	};

	const maybeCompact = (ctx: ExtensionContext): void => {
		const config = resolveConfig(ctx);
		const usage = ctx.getContextUsage();
		const tokens = usage?.tokens ?? null;
		const limit = effectiveLimit(config, usage?.contextWindow);

		if (limit === undefined || tokens === null || tokens < limit.limit) {
			// Below the limit: this crossing is handled, the next one may fire again.
			armed = true;
			return;
		}
		if (!config.enabled) return;
		// Headless modes process one prompt and exit; a compaction started here would
		// only be aborted a moment later, after paying for the summarization call.
		if (ctx.mode === "print" || ctx.mode === "json") return;
		if (isCompacting() || !ctx.isIdle()) return;
		if (!armed || Date.now() < retryBlockedUntil) return;
		if (turnsSinceCompaction < MIN_TURNS_BETWEEN_COMPACTIONS) return;

		armed = false;
		turnsSinceCompaction = 0;
		compactingSince = Date.now();
		if (ctx.hasUI) {
			ctx.ui.notify(
				`Auto-compact: ${formatTokens(tokens)} tokens ≥ ${formatTokens(limit.limit)} (${limit.label})`,
				"info",
			);
		}

		ctx.compact({
			onComplete: clearCompacting,
			onError: (error) => {
				clearCompacting();
				armed = true;
				// No compaction happened, so the turn throttle does not apply to the retry.
				turnsSinceCompaction = Number.POSITIVE_INFINITY;
				retryBlockedUntil = Date.now() + FAILURE_RETRY_DELAY_MS;
				if (ctx.hasUI) ctx.ui.notify(`Auto-compact failed: ${error.message}`, "error");
			},
		});
	};

	// -------------------------------------------------------------------------
	// CLI flags
	// -------------------------------------------------------------------------

	pi.registerFlag("autocompact-percent", {
		description: "Auto-compact when context usage reaches this % of the model context window",
		type: "string",
	});
	pi.registerFlag("autocompact-tokens", {
		description: "Auto-compact when the context reaches this absolute token count",
		type: "string",
	});
	pi.registerFlag("autocompact-off", {
		description: "Disable auto-compaction for this run",
		type: "boolean",
	});

	// -------------------------------------------------------------------------
	// Events
	// -------------------------------------------------------------------------

	pi.on("session_start", () => {
		// No compaction here: a resumed session over the limit is compacted after its next run.
		clearCompacting();
		armed = true;
		turnsSinceCompaction = Number.POSITIVE_INFINITY;
		retryBlockedUntil = 0;
	});

	pi.on("turn_end", () => {
		// Only used for the throttle; compaction happens once a run has finished.
		if (turnsSinceCompaction !== Number.POSITIVE_INFINITY) turnsSinceCompaction += 1;
	});

	pi.on("agent_settled", (_event, ctx) => {
		maybeCompact(ctx);
	});

	pi.on("model_select", () => {
		// The percent limit changed with the context window; re-check after the next run.
		armed = true;
	});

	pi.on("session_before_compact", () => {
		// Another compaction (manual, threshold, overflow) is running: stay out of its way.
		if (compactingSince === undefined) compactingSince = Date.now();
	});

	pi.on("session_compact", () => {
		// Fires for *any* compaction (manual, threshold, overflow, other extensions),
		// so this only fixes up our own state.
		clearCompacting();
		armed = true;
		turnsSinceCompaction = 0;
	});

	// -------------------------------------------------------------------------
	// /autocompact command
	// -------------------------------------------------------------------------

	const describe = (ctx: ExtensionContext): string => {
		const config = resolveConfig(ctx);
		const usage = ctx.getContextUsage();
		const limit = effectiveLimit(config, usage?.contextWindow);
		const lines = [
			`Auto-compact: ${config.enabled ? "enabled" : "disabled"} (compacts when an agent run ends)`,
			`  percent     ${config.percent === null ? "off" : `${config.percent}%`}`,
			`  tokens      ${config.tokens === null ? "off" : formatTokens(config.tokens)}`,
			limit === undefined
				? "  effective   no limit configured — auto-compact will not run"
				: `  effective   min(...) = ${formatTokens(limit.limit)} tokens (${limit.label})`,
			usage?.tokens === null || usage?.tokens === undefined
				? "  now         unknown"
				: `  now         ${formatTokens(usage.tokens)} tokens`,
			`  file        ${join(getAgentDir(), CONFIG_FILE)}`,
		];
		return lines.join("\n");
	};

	pi.registerCommand("autocompact", {
		description: "Show or change auto-compaction thresholds",
		getArgumentCompletions: (prefix) => {
			const items = [
				{ value: "status", label: "status", description: "Show current thresholds" },
				{ value: "on", label: "on", description: "Enable auto-compaction" },
				{ value: "off", label: "off", description: "Disable auto-compaction" },
				{ value: "percent", label: "percent <n|off>", description: "Context % threshold" },
				{ value: "tokens", label: "tokens <n|off>", description: "Absolute token threshold" },
			];
			const filtered = items.filter((item) => item.value.startsWith(prefix.trim()));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const [sub = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
			const value = rest.join(" ").trim();
			const apply = (patch: RawConfig): void => {
				writeConfig(patch);
				armed = true;
				retryBlockedUntil = 0;
			};

			switch (sub.toLowerCase()) {
				case "":
				case "status":
				case "help": {
					ctx.ui.notify(describe(ctx), "info");
					return;
				}
				case "on":
				case "off": {
					const enabled = sub.toLowerCase() === "on";
					apply({ enabled });
					ctx.ui.notify(`Auto-compact ${enabled ? "enabled" : "disabled"}`, "info");
					return;
				}
				case "percent":
				case "tokens": {
					const key = sub.toLowerCase() as "percent" | "tokens";
					const current = resolveConfig(ctx)[key];
					if (!value) {
						ctx.ui.notify(`${key} is currently ${current === null ? "off" : current}`, "info");
						return;
					}
					const next = value === "off" ? null : Number(value);
					if (Number.isNaN(next)) {
						ctx.ui.notify(`Invalid ${key}: ${value}`, "error");
						return;
					}
					apply({ [key]: next });
					ctx.ui.notify(`${key}: ${next === null ? "off" : next}`, "info");
					return;
				}
				default: {
					ctx.ui.notify(`Unknown subcommand "${sub}".\n${describe(ctx)}`, "warning");
				}
			}
		},
	});
}
