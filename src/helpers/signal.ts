import { SIGNAL_CONFIG } from "../configs/signal-config.ts";
import type { OptionChainEntry } from "./analysis.ts";

// --------------------------------------------------------------------------
// Input / Output types
// --------------------------------------------------------------------------

export interface SignalGateInputs {
	spotPrice: number;
	maxPain: number;
	pcr: { pcr: number; bias: string };
	oiDynamics: {
		summary: {
			totalCallChange: number;
			totalPutChange: number;
			trendShifting: string;
		};
	};
	technicals: {
		indicators: { rsi: number | null };
		implication: { trendRating: string };
	} | null;
	volatility: {
		atmProfile: { atmIV: number };
	} | null;
	activeOI: {
		resistance: { strike: number; oi: number };
		support: { strike: number; oi: number };
	};
	targetContractType: "CALL" | "PUT" | "SPREAD" | "NONE";
	/** Optional: ordered PCR readings oldest→newest from session memory */
	pcrHistory?: number[];
}

// --------------------------------------------------------------------------
// PcrTrendResult
// --------------------------------------------------------------------------

export interface PcrTrendResult {
	trend: "RISING" | "FALLING" | "FLAT" | "INSUFFICIENT_DATA";
	changePct: number; // % change from oldest to newest reading
	readings: number;
}

// --------------------------------------------------------------------------
// computePcrTrend — derive intraday PCR momentum from session history
// --------------------------------------------------------------------------

export function computePcrTrend(history: number[]): PcrTrendResult {
	const cfg = SIGNAL_CONFIG.pcrTrend;

	if (history.length < cfg.minReadings) {
		return {
			trend: "INSUFFICIENT_DATA",
			changePct: 0,
			readings: history.length,
		};
	}

	const oldest = history[0] as number;
	const newest = history[history.length - 1] as number;

	if (oldest === 0) {
		return {
			trend: "INSUFFICIENT_DATA",
			changePct: 0,
			readings: history.length,
		};
	}

	const changePct = ((newest - oldest) / oldest) * 100;

	let trend: PcrTrendResult["trend"] = "FLAT";
	if (changePct >= cfg.risingThreshold * 100) trend = "RISING";
	else if (changePct <= -(cfg.fallingThreshold * 100)) trend = "FALLING";

	return {
		trend,
		changePct: Number(changePct.toFixed(2)),
		readings: history.length,
	};
}

export interface SignalGateResult {
	direction: "BULLISH" | "BEARISH" | "NO_TRADE";
	conviction: "HIGH" | "MEDIUM" | "NO_TRADE";
	mandatoryPassed: boolean;
	mandatoryReason: string;
	confirmationsHit: string[];
	confirmationCount: number;
	disqualified: boolean;
	disqualifyReason: string | null;
}

export interface StrikeSelection {
	selectedStrike: number;
	instrumentKey: string;
	optionType: "call" | "put";
	ltp: number;
	delta: number;
	iv: number;
	oi: number;
	volume: number;
	liquidityWarning: boolean;
}

// --------------------------------------------------------------------------
// Direction resolution
// --------------------------------------------------------------------------

function resolveDirection(
	pcrBias: string,
	trendShifting: string,
): "BULLISH" | "BEARISH" | "AMBIGUOUS" {
	const pcrBullish = pcrBias === "EXTREMELY_BULLISH" || pcrBias === "BULLISH";
	const pcrBearish = pcrBias === "EXTREMELY_BEARISH" || pcrBias === "BEARISH";
	const oiBullish = trendShifting.startsWith("BULLISH_");
	const oiBearish = trendShifting.startsWith("BEARISH_");

	if (pcrBullish && oiBearish) return "AMBIGUOUS"; // contradiction
	if (pcrBearish && oiBullish) return "AMBIGUOUS"; // contradiction
	if (pcrBullish || oiBullish) return "BULLISH";
	if (pcrBearish || oiBearish) return "BEARISH";
	return "AMBIGUOUS";
}

// --------------------------------------------------------------------------
// evaluateSignalGates — the core rule engine
// --------------------------------------------------------------------------

export function evaluateSignalGates(
	inputs: SignalGateInputs,
): SignalGateResult {
	const cfg = SIGNAL_CONFIG;
	const {
		spotPrice,
		maxPain,
		pcr,
		oiDynamics,
		technicals,
		volatility,
		activeOI,
		targetContractType,
	} = inputs;

	const trendShifting = oiDynamics.summary.trendShifting;
	const atmIV = volatility?.atmProfile.atmIV ?? 0;
	const rsi = technicals?.indicators.rsi ?? null;
	const trendRating = technicals?.implication.trendRating ?? "NEUTRAL";
	const isBuyingStrategy =
		targetContractType === "CALL" || targetContractType === "PUT";
	const pcrTrend = inputs.pcrHistory
		? computePcrTrend(inputs.pcrHistory)
		: null;

	// ── 1. Direction ────────────────────────────────────────────────────────
	const resolvedDir = resolveDirection(pcr.bias, trendShifting);

	// Contradiction between PCR and OI dynamics is an immediate disqualifier
	if (resolvedDir === "AMBIGUOUS") {
		return {
			direction: "NO_TRADE",
			conviction: "NO_TRADE",
			mandatoryPassed: false,
			mandatoryReason:
				"PCR direction contradicts OI dynamics — ambiguous setup",
			confirmationsHit: [],
			confirmationCount: 0,
			disqualified: true,
			disqualifyReason: "PCR and OI dynamics point in opposite directions",
		};
	}

	const direction = resolvedDir;

	// ── 2. Mandatory gates ───────────────────────────────────────────────────
	const pcrExtreme =
		pcr.pcr > cfg.pcr.extremeBullish || pcr.pcr < cfg.pcr.extremeBearish;
	const oiUnambiguous =
		trendShifting.startsWith("BULLISH_") ||
		trendShifting.startsWith("BEARISH_");

	const mandatoryPassed = pcrExtreme || oiUnambiguous;
	const mandatoryReason = !mandatoryPassed
		? `PCR (${pcr.pcr}) is in neutral zone and OI dynamics are ambiguous (${trendShifting})`
		: pcrExtreme && oiUnambiguous
			? `PCR extreme (${pcr.pcr}) confirmed by OI dynamics (${trendShifting})`
			: pcrExtreme
				? `PCR extreme (${pcr.pcr})`
				: `OI dynamics unambiguous (${trendShifting})`;

	if (!mandatoryPassed) {
		return {
			direction,
			conviction: "NO_TRADE",
			mandatoryPassed: false,
			mandatoryReason,
			confirmationsHit: [],
			confirmationCount: 0,
			disqualified: false,
			disqualifyReason: null,
		};
	}

	// ── 3. Disqualifiers ─────────────────────────────────────────────────────

	// RSI exhaustion check
	if (rsi !== null) {
		if (direction === "BULLISH" && rsi > cfg.rsi.overbought) {
			return {
				direction,
				conviction: "NO_TRADE",
				mandatoryPassed: true,
				mandatoryReason,
				confirmationsHit: [],
				confirmationCount: 0,
				disqualified: true,
				disqualifyReason: `RSI overbought (${rsi.toFixed(1)} > ${cfg.rsi.overbought}) — bullish momentum likely exhausted`,
			};
		}
		if (direction === "BEARISH" && rsi < cfg.rsi.oversold) {
			return {
				direction,
				conviction: "NO_TRADE",
				mandatoryPassed: true,
				mandatoryReason,
				confirmationsHit: [],
				confirmationCount: 0,
				disqualified: true,
				disqualifyReason: `RSI oversold (${rsi.toFixed(1)} < ${cfg.rsi.oversold}) — bearish momentum likely exhausted`,
			};
		}
	}

	// Premium trap: buying into extreme IV
	if (isBuyingStrategy && atmIV > cfg.iv.premiumTrap) {
		return {
			direction,
			conviction: "NO_TRADE",
			mandatoryPassed: true,
			mandatoryReason,
			confirmationsHit: [],
			confirmationCount: 0,
			disqualified: true,
			disqualifyReason: `ATM IV (${atmIV}%) exceeds premium trap threshold (${cfg.iv.premiumTrap}%) — buying structurally unfavorable`,
		};
	}

	// ── 4. Confirmation factors ───────────────────────────────────────────────
	const confirmationsHit: string[] = [];

	// Confirmation 1: Technical trend aligns
	const trendAligns =
		(direction === "BULLISH" &&
			(trendRating === "STRONG_BULLISH" || trendRating === "BULLISH")) ||
		(direction === "BEARISH" &&
			(trendRating === "STRONG_BEARISH" || trendRating === "BEARISH"));
	if (trendAligns)
		confirmationsHit.push(`Technical trend aligned (${trendRating})`);

	// Confirmation 2: Max pain gravitational pull
	const maxPainDistance = Math.abs(spotPrice - maxPain) / spotPrice;
	if (maxPainDistance > cfg.proximity.maxPainNeutralZonePct) {
		const maxPainPull =
			(direction === "BULLISH" && spotPrice < maxPain) ||
			(direction === "BEARISH" && spotPrice > maxPain);
		if (maxPainPull) {
			confirmationsHit.push(
				`Max pain pull ${direction === "BULLISH" ? "upward" : "downward"} (spot ${spotPrice} vs max pain ${maxPain})`,
			);
		}
	}

	// Confirmation 3: Spot near key OI level
	if (direction === "BULLISH") {
		const distToSupport =
			Math.abs(spotPrice - activeOI.support.strike) / spotPrice;
		if (distToSupport <= cfg.proximity.keyLevelPct) {
			confirmationsHit.push(
				`Spot within ${(distToSupport * 100).toFixed(2)}% of Put OI support (${activeOI.support.strike})`,
			);
		}
	} else {
		const distToResistance =
			Math.abs(spotPrice - activeOI.resistance.strike) / spotPrice;
		if (distToResistance <= cfg.proximity.keyLevelPct) {
			confirmationsHit.push(
				`Spot within ${(distToResistance * 100).toFixed(2)}% of Call OI resistance (${activeOI.resistance.strike})`,
			);
		}
	}

	// Confirmation 4: IV environment favorable for strategy type
	if (isBuyingStrategy && atmIV > 0 && atmIV < cfg.iv.cheap) {
		confirmationsHit.push(
			`IV environment cheap for buyers (ATM IV: ${atmIV}%)`,
		);
	} else if (!isBuyingStrategy && atmIV >= cfg.iv.sellingFavorable) {
		confirmationsHit.push(
			`IV environment favorable for sellers (ATM IV: ${atmIV}%)`,
		);
	}

	// Confirmation 5: PCR trend momentum (from session memory)
	if (pcrTrend && pcrTrend.trend !== "INSUFFICIENT_DATA") {
		const trendAlignsBullish =
			direction === "BULLISH" && pcrTrend.trend === "RISING";
		const trendAlignsBearish =
			direction === "BEARISH" && pcrTrend.trend === "FALLING";
		if (trendAlignsBullish || trendAlignsBearish) {
			confirmationsHit.push(
				`PCR trending ${pcrTrend.trend.toLowerCase()} (${pcrTrend.changePct > 0 ? "+" : ""}${pcrTrend.changePct}% over ${pcrTrend.readings} readings) — momentum building`,
			);
		}
	}

	// ── 5. Conviction ─────────────────────────────────────────────────────────
	const confirmationCount = confirmationsHit.length;
	let conviction: "HIGH" | "MEDIUM" | "NO_TRADE";

	if (confirmationCount >= cfg.confirmations.required) {
		conviction = "HIGH";
	} else if (confirmationCount >= 1) {
		conviction = "MEDIUM";
	} else {
		conviction = "NO_TRADE";
	}

	return {
		direction,
		conviction,
		mandatoryPassed: true,
		mandatoryReason,
		confirmationsHit,
		confirmationCount,
		disqualified: false,
		disqualifyReason: null,
	};
}

// --------------------------------------------------------------------------
// selectOptimalStrike — picks the best entry strike from the chain
// --------------------------------------------------------------------------

export function selectOptimalStrike(
	entries: OptionChainEntry[],
	direction: "BULLISH" | "BEARISH",
	atmIV: number,
): StrikeSelection | null {
	const cfg = SIGNAL_CONFIG;
	const isCall = direction === "BULLISH";
	const ivCap = atmIV > 0 ? atmIV * 1.2 : Number.POSITIVE_INFINITY;

	interface Candidate {
		strike: number;
		instrumentKey: string;
		ltp: number;
		delta: number;
		iv: number;
		oi: number;
		volume: number;
	}

	const candidates: Candidate[] = [];

	for (const entry of entries) {
		const option = isCall ? entry.call_options : entry.put_options;
		if (!option) continue;

		const ltp = option.market_data?.ltp ?? 0;
		const oi = option.market_data?.oi ?? 0;
		const volume = option.market_data?.volume ?? 0;
		const iv = option.option_greeks?.implied_volatility ?? 0;
		const rawDelta = option.option_greeks?.delta ?? 0;
		// Put deltas are negative — use absolute value for range check
		const delta = Math.abs(rawDelta);

		if (
			delta >= cfg.delta.min &&
			delta <= cfg.delta.max &&
			oi >= cfg.liquidity.minOI &&
			volume >= cfg.liquidity.minVolume &&
			(ivCap === Number.POSITIVE_INFINITY || iv <= ivCap)
		) {
			candidates.push({
				strike: entry.strike_price,
				instrumentKey: option.instrument_key,
				ltp,
				delta,
				iv,
				oi,
				volume,
			});
		}
	}

	// Among qualifying candidates, pick highest OI (tightest spread, most liquid)
	if (candidates.length > 0) {
		const best = candidates.reduce((a, b) => (a.oi > b.oi ? a : b));
		return {
			selectedStrike: best.strike,
			instrumentKey: best.instrumentKey,
			ltp: best.ltp,
			delta: best.delta,
			iv: best.iv,
			oi: best.oi,
			volume: best.volume,
			optionType: isCall ? "call" : "put",
			liquidityWarning: false,
		};
	}

	// Fallback: relax OI threshold, find closest to ATM
	const spotPrice = entries[0]?.underlying_spot_price ?? 0;
	let atmFallback: Candidate | null = null;
	let minDist = Number.POSITIVE_INFINITY;

	for (const entry of entries) {
		const option = isCall ? entry.call_options : entry.put_options;
		if (!option) continue;

		const oi = option.market_data?.oi ?? 0;
		if (oi < cfg.liquidity.fallbackMinOI) continue;

		const dist = Math.abs(entry.strike_price - spotPrice);
		if (dist < minDist) {
			minDist = dist;
			atmFallback = {
				strike: entry.strike_price,
				instrumentKey: option.instrument_key,
				ltp: option.market_data?.ltp ?? 0,
				delta: Math.abs(option.option_greeks?.delta ?? 0),
				iv: option.option_greeks?.implied_volatility ?? 0,
				oi,
				volume: option.market_data?.volume ?? 0,
			};
		}
	}

	if (atmFallback) {
		return {
			selectedStrike: atmFallback.strike,
			instrumentKey: atmFallback.instrumentKey,
			ltp: atmFallback.ltp,
			delta: atmFallback.delta,
			iv: atmFallback.iv,
			oi: atmFallback.oi,
			volume: atmFallback.volume,
			optionType: isCall ? "call" : "put",
			liquidityWarning: true,
		};
	}

	return null;
}
