import { ATR, BollingerBands, EMA, MACD, RSI, SMA } from "technicalindicators";
import { calculateImpliedVolatility, daysToExpiry } from "./blackscholes.ts";

export interface OptionMarketData {
	ltp?: number;
	volume?: number;
	oi?: number;
	close_price?: number;
	bid_price?: number;
	bid_qty?: number;
	ask_price?: number;
	ask_qty?: number;
	prev_oi?: number;
}

export interface OptionGreeks {
	delta?: number;
	gamma?: number;
	theta?: number;
	vega?: number;
	iv?: number;
	pop?: number;
}

export interface OptionDetail {
	instrument_key: string;
	market_data?: OptionMarketData;
	option_greeks?: OptionGreeks;
}

export interface OptionChainEntry {
	expiry: string;
	strike_price: number;
	underlying_key: string;
	underlying_spot_price: number;
	pcr?: number;
	call_options?: OptionDetail;
	put_options?: OptionDetail;
}

export interface OptionChainResponse {
	status: string;
	data: OptionChainEntry[];
}

export interface RawChangeOIEntry {
	strike_price: number;
	call_change_oi?: number;
	put_change_oi?: number;
}

// Actual shape returned by Upstox /v2/market/change-oi
export interface ChangeOIData {
	call_put_oi_data_list: RawChangeOIEntry[];
	total_call_change_oi?: number;
	total_put_change_oi?: number;
	spot_closing_price?: number;
	expiry?: string;
}

export type RawCandleArray = [
	string, // timestamp
	number, // open
	number, // high
	number, // low
	number, // close
	number, // volume
	number, // open interest
];

/**
 * Identify Active Open Interest (OI) Support and Resistance strikes.
 */
export function analyzeActiveOI(entries: OptionChainEntry[]) {
	let highestCallOI = 0;
	let highestCallStrike = 0;
	let highestCallVolume = 0;
	let highestCallLtp = 0;

	let highestPutOI = 0;
	let highestPutStrike = 0;
	let highestPutVolume = 0;
	let highestPutLtp = 0;

	for (const entry of entries) {
		// Call analysis
		if (entry.call_options?.market_data) {
			const callOI = entry.call_options.market_data.oi || 0;
			if (callOI > highestCallOI) {
				highestCallOI = callOI;
				highestCallStrike = entry.strike_price;
				highestCallVolume = entry.call_options.market_data.volume || 0;
				highestCallLtp = entry.call_options.market_data.ltp || 0;
			}
		}

		// Put analysis
		if (entry.put_options?.market_data) {
			const putOI = entry.put_options.market_data.oi || 0;
			if (putOI > highestPutOI) {
				highestPutOI = putOI;
				highestPutStrike = entry.strike_price;
				highestPutVolume = entry.put_options.market_data.volume || 0;
				highestPutLtp = entry.put_options.market_data.ltp || 0;
			}
		}
	}

	return {
		resistance: {
			strike: highestCallStrike,
			oi: highestCallOI,
			volume: highestCallVolume,
			ltp: highestCallLtp,
		},
		support: {
			strike: highestPutStrike,
			oi: highestPutOI,
			volume: highestPutVolume,
			ltp: highestPutLtp,
		},
	};
}

/**
 * Compute overall Option Put-Call Ratio (PCR) and its bias.
 */
export function calculatePCR(entries: OptionChainEntry[]) {
	let totalCallOI = 0;
	let totalPutOI = 0;

	for (const entry of entries) {
		totalCallOI += entry.call_options?.market_data?.oi || 0;
		totalPutOI += entry.put_options?.market_data?.oi || 0;
	}

	const pcr =
		totalCallOI > 0 ? Number((totalPutOI / totalCallOI).toFixed(3)) : 0;

	let bias:
		| "EXTREMELY_BULLISH"
		| "BULLISH"
		| "NEUTRAL"
		| "BEARISH"
		| "EXTREMELY_BEARISH" = "NEUTRAL";
	let interpretation = "Market in consolidation range. Neutral balance.";

	if (pcr > 1.25) {
		bias = "EXTREMELY_BULLISH";
		interpretation =
			"Highly bullish sentiment. Put writers dominating (strong support floor). Potential overbought risk.";
	} else if (pcr > 1.0) {
		bias = "BULLISH";
		interpretation = "Bullish sentiment. Put writers outnumber call writers.";
	} else if (pcr >= 0.8) {
		bias = "NEUTRAL";
		interpretation = "Balanced sentiment. Rangebound trend.";
	} else if (pcr >= 0.6) {
		bias = "BEARISH";
		interpretation =
			"Bearish sentiment. Call writers outnumber put writers (strong resistance overhead).";
	} else {
		bias = "EXTREMELY_BEARISH";
		interpretation =
			"Highly bearish sentiment. Call writers dominating. Potential oversold rebound candidate.";
	}

	return {
		pcr,
		totalCallOI,
		totalPutOI,
		bias,
		interpretation,
	};
}

/**
 * Calculate the option Max Pain strike price.
 */
export function calculateMaxPain(entries: OptionChainEntry[]): number {
	if (entries.length === 0) return 0;

	// Filter strikes that actually have open interest
	const strikes = entries.map((e) => e.strike_price).sort((a, b) => a - b);
	let minPainScore = Infinity;
	let maxPainStrike = strikes[0] || 0;

	for (const candidateStrike of strikes) {
		let totalPain = 0;

		for (const entry of entries) {
			const strike = entry.strike_price;
			const callOI = entry.call_options?.market_data?.oi || 0;
			const putOI = entry.put_options?.market_data?.oi || 0;

			// Call buyer's pain if spot expires at candidateStrike
			if (candidateStrike > strike) {
				totalPain += (candidateStrike - strike) * callOI;
			}

			// Put buyer's pain if spot expires at candidateStrike
			if (candidateStrike < strike) {
				totalPain += (strike - candidateStrike) * putOI;
			}
		}

		if (totalPain < minPainScore) {
			minPainScore = totalPain;
			maxPainStrike = candidateStrike;
		}
	}

	return maxPainStrike;
}

/**
 * Generate aggregate technical options-trading recommendations
 */
export function generateRecommendation(
	spotPrice: number,
	resistance: { strike: number; oi: number },
	support: { strike: number; oi: number },
	pcr: { pcr: number; bias: string },
	maxPain: number,
) {
	let action = "HOLD";
	let targetContractType: "CALL" | "PUT" | "SPREAD" | "NONE" = "NONE";
	let strategyName = "Wait and Watch (Neutral)";
	let conviction: "HIGH" | "MEDIUM" | "LOW" = "LOW";
	let rationale = "";

	const isSpotNearSupport =
		Math.abs(spotPrice - support.strike) / spotPrice < 0.015;
	const isSpotNearResistance =
		Math.abs(spotPrice - resistance.strike) / spotPrice < 0.015;

	if (pcr.pcr > 1.25) {
		action = "BUY";
		targetContractType = "CALL";
		strategyName = "Long Call Option (Bullish Momentum)";
		conviction = "HIGH";
		rationale = `Strong bullish alignment. PCR is high (${pcr.pcr}) showing strong put writing support. Spot price ($${spotPrice.toFixed(2)}) has support at ${support.strike}.`;
	} else if (pcr.pcr < 0.6) {
		action = "BUY";
		targetContractType = "PUT";
		strategyName = "Long Put Option (Bearish Momentum)";
		conviction = "HIGH";
		rationale = `Strong bearish alignment. PCR is very low (${pcr.pcr}) showing call writing heavy resistance overhead at ${resistance.strike}.`;
	} else if (isSpotNearSupport && pcr.pcr >= 0.8) {
		action = "BUY";
		targetContractType = "CALL";
		strategyName = "Support Bounce (Bullish Buy)";
		conviction = "MEDIUM";
		rationale = `Spot price ($${spotPrice.toFixed(2)}) is close to the heavy Active Put OI Support floor of ${support.strike}. Anticipating a technical bounce.`;
	} else if (isSpotNearResistance && pcr.pcr <= 1.0) {
		action = "BUY";
		targetContractType = "PUT";
		strategyName = "Resistance Rejection (Bearish Short)";
		conviction = "MEDIUM";
		rationale = `Spot price ($${spotPrice.toFixed(2)}) is testing the heavy Active Call OI Resistance ceiling at ${resistance.strike}. Anticipating an intraday pullback.`;
	} else if (pcr.pcr >= 0.8 && pcr.pcr <= 1.15) {
		action = "SELL";
		targetContractType = "SPREAD";
		strategyName = "Short Strangle (Rangebound yield)";
		conviction = "MEDIUM";
		rationale = `Market is highly rangebound. Spot ($${spotPrice.toFixed(2)}) is sitting comfortably between Support (${support.strike}) and Resistance (${resistance.strike}) with stable PCR (${pcr.pcr}). Sell OTM calls and puts.`;
	} else {
		action = "HOLD";
		targetContractType = "NONE";
		strategyName = "No-Trade Zone (Wait for setup)";
		conviction = "LOW";
		rationale = `PCR (${pcr.pcr}) and key levels are showing mixed/unclear signals. Stand aside and wait for a clear support/resistance breakout.`;
	}

	return {
		action,
		targetContractType,
		strategyName,
		conviction,
		rationale,
		keyLevels: {
			resistance: resistance.strike,
			support: support.strike,
			maxPain,
			currentSpot: Number(spotPrice.toFixed(2)),
		},
	};
}

/**
 * Calculates intraday Open Interest (OI) Dynamics from strike-wise change data.
 */
export function analyzeOIDynamics(entries: RawChangeOIEntry[]) {
	let totalCallChange = 0;
	let totalPutChange = 0;

	let maxCallWriteOI = -Infinity;
	let maxCallWriteStrike = 0;

	let maxCallCoverOI = Infinity;
	let maxCallCoverStrike = 0;

	let maxPutWriteOI = -Infinity;
	let maxPutWriteStrike = 0;

	let maxPutCoverOI = Infinity;
	let maxPutCoverStrike = 0;

	for (const entry of entries) {
		const callChg = entry.call_change_oi || 0;
		const putChg = entry.put_change_oi || 0;

		totalCallChange += callChg;
		totalPutChange += putChg;

		// Call writing peaks
		if (callChg > maxCallWriteOI) {
			maxCallWriteOI = callChg;
			maxCallWriteStrike = entry.strike_price;
		}

		// Call unwinding/covering peaks
		if (callChg < maxCallCoverOI) {
			maxCallCoverOI = callChg;
			maxCallCoverStrike = entry.strike_price;
		}

		// Put writing peaks
		if (putChg > maxPutWriteOI) {
			maxPutWriteOI = putChg;
			maxPutWriteStrike = entry.strike_price;
		}

		// Put unwinding peaks
		if (putChg < maxPutCoverOI) {
			maxPutCoverOI = putChg;
			maxPutCoverStrike = entry.strike_price;
		}
	}

	const shiftRatio =
		totalCallChange !== 0
			? Number((totalPutChange / totalCallChange).toFixed(3))
			: 0;

	let trendShifting = "NEUTRAL";
	if (totalPutChange > 0 && totalCallChange < 0) {
		trendShifting =
			"BULLISH_REVERSION (Put writing building, Call covering happening)";
	} else if (totalCallChange > 0 && totalPutChange < 0) {
		trendShifting =
			"BEARISH_REVERSION (Call writing building, Put covering happening)";
	} else if (shiftRatio > 1.2) {
		trendShifting = "BULLISH_MOMENTUM (Put change dominates call change)";
	} else if (shiftRatio > 0 && shiftRatio < 0.6) {
		trendShifting = "BEARISH_MOMENTUM (Call change dominates put change)";
	}

	return {
		summary: {
			totalCallChange,
			totalPutChange,
			shiftRatio,
			trendShifting,
		},
		peaks: {
			callWriting: { strike: maxCallWriteStrike, change: maxCallWriteOI },
			callCovering: { strike: maxCallCoverStrike, change: maxCallCoverOI },
			putWriting: { strike: maxPutWriteStrike, change: maxPutWriteOI },
			putCovering: { strike: maxPutCoverStrike, change: maxPutCoverOI },
		},
	};
}

/**
 * Calculates Implied Volatility ATM profile and IV Skew metrics.
 */
export function calculateVolatilityProfile(entries: OptionChainEntry[]) {
	if (entries.length === 0) return null;

	const spotPrice = entries[0]?.underlying_spot_price || 0;
	const sorted = [...entries].sort((a, b) => a.strike_price - b.strike_price);

	// Locate closest ATM entry
	let closestIdx = 0;
	let minDiff = Infinity;
	for (let i = 0; i < sorted.length; i++) {
		const entry = sorted[i];
		if (entry) {
			const diff = Math.abs(entry.strike_price - spotPrice);
			if (diff < minDiff) {
				minDiff = diff;
				closestIdx = i;
			}
		}
	}

	const atmEntry = sorted[closestIdx];
	const tte = daysToExpiry(atmEntry?.expiry ?? "") / 365;

	const resolveIV = (
		rawIV: number | undefined,
		ltp: number | undefined,
		strike: number,
		isCall: boolean,
	): number => {
		if (rawIV && rawIV > 0) return rawIV;
		if (!ltp || ltp <= 0) return 0;
		return calculateImpliedVolatility(ltp, spotPrice, strike, tte, isCall) ?? 0;
	};

	const atmCallIV = resolveIV(
		atmEntry?.call_options?.option_greeks?.iv,
		atmEntry?.call_options?.market_data?.ltp,
		atmEntry?.strike_price ?? 0,
		true,
	);
	const atmPutIV = resolveIV(
		atmEntry?.put_options?.option_greeks?.iv,
		atmEntry?.put_options?.market_data?.ltp,
		atmEntry?.strike_price ?? 0,
		false,
	);
	const atmIV = Number(((atmCallIV + atmPutIV) / 2).toFixed(2));

	// Calculate IV Skew: Equidistant out-of-the-money options (e.g. 3 strikes OTM)
	const callOtmIdx = Math.min(sorted.length - 1, closestIdx + 3);
	const putOtmIdx = Math.max(0, closestIdx - 3);

	const callOtmEntry = sorted[callOtmIdx];
	const putOtmEntry = sorted[putOtmIdx];

	const otmCallIV = resolveIV(
		callOtmEntry?.call_options?.option_greeks?.iv,
		callOtmEntry?.call_options?.market_data?.ltp,
		callOtmEntry?.strike_price ?? 0,
		true,
	);
	const otmPutIV = resolveIV(
		putOtmEntry?.put_options?.option_greeks?.iv,
		putOtmEntry?.put_options?.market_data?.ltp,
		putOtmEntry?.strike_price ?? 0,
		false,
	);

	// Skew = Put IV - Call IV
	const skew = Number((otmPutIV - otmCallIV).toFixed(2));

	let skewImplication = "NEUTRAL";
	if (skew > 1.5) {
		skewImplication =
			"DOWNSIDE_FEAR (OTM Puts are expensive relative to OTM Calls - bearish hedging)";
	} else if (skew < -1.5) {
		skewImplication =
			"UPSIDE_CHASE (OTM Calls are expensive relative to OTM Puts - bullish chasing)";
	} else {
		skewImplication =
			"BALANCED_VOLATILITY (Options market is not anticipating sharp directional moves)";
	}

	return {
		spotPrice: Number(spotPrice.toFixed(2)),
		atmProfile: {
			strike: atmEntry?.strike_price || 0,
			callIV: atmCallIV,
			putIV: atmPutIV,
			atmIV,
		},
		otmProfile: {
			otmCallStrike: callOtmEntry?.strike_price || 0,
			otmCallIV,
			otmPutStrike: putOtmEntry?.strike_price || 0,
			otmPutIV,
		},
		skewMetrics: {
			skew,
			skewImplication,
		},
	};
}

export function calculateTechnicalIndicators(rawCandles: RawCandleArray[]) {
	if (rawCandles.length === 0) return null;

	// Upstox returns candles newest first usually, let's reverse to process oldest to newest for indices!
	const candles = [...rawCandles].reverse();
	const closes = candles.map((c) => c[4]);
	const highs = candles.map((c) => c[2]);
	const lows = candles.map((c) => c[3]);
	const count = closes.length;

	// 1. Calculate Moving Averages
	const sma20 = SMA.calculate({ values: closes, period: 20 });
	const sma50 = SMA.calculate({ values: closes, period: 50 });
	const sma200 = SMA.calculate({ values: closes, period: 200 });

	const ema9 = EMA.calculate({ values: closes, period: 9 });
	const ema20 = EMA.calculate({ values: closes, period: 20 });

	// 2. Calculate Momentum & Volatility Indicators
	const rsi = RSI.calculate({ values: closes, period: 14 });
	const macd = MACD.calculate({
		values: closes,
		fastPeriod: 12,
		slowPeriod: 26,
		signalPeriod: 9,
		SimpleMAOscillator: false,
		SimpleMASignal: false,
	});
	const bb = BollingerBands.calculate({
		values: closes,
		period: 20,
		stdDev: 2,
	});
	const atr = ATR.calculate({
		high: highs,
		low: lows,
		close: closes,
		period: 14,
	});

	const currentPrice = closes[count - 1] || 0;

	// Utility to get the last computed value safely
	const getLatest = <T>(arr: T[]): T | null => {
		const val = arr && arr.length > 0 ? arr[arr.length - 1] : undefined;
		return val !== undefined ? val : null;
	};

	const latestSma20 = getLatest(sma20);
	const latestSma50 = getLatest(sma50);
	const latestSma200 = getLatest(sma200);
	const latestEma9 = getLatest(ema9);
	const latestEma20 = getLatest(ema20);
	const latestRsi = getLatest(rsi);
	const latestMacd = getLatest(macd);
	const latestBb = getLatest(bb);
	const latestAtr = getLatest(atr);

	// Trend Implication Logic based on moving averages and RSI
	let trendRating = "NEUTRAL";
	const effectiveSma20 = latestSma20 || 0;
	const effectiveSma50 = latestSma50 || 0;
	const effectiveRsi = latestRsi || 50;

	if (effectiveSma20 > 0 && effectiveSma50 > 0) {
		if (
			currentPrice > effectiveSma20 &&
			effectiveSma20 > effectiveSma50 &&
			effectiveRsi > 55
		) {
			trendRating = "STRONG_BULLISH";
		} else if (currentPrice > effectiveSma20 && effectiveRsi >= 50) {
			trendRating = "BULLISH";
		} else if (
			currentPrice < effectiveSma20 &&
			effectiveSma20 < effectiveSma50 &&
			effectiveRsi < 45
		) {
			trendRating = "STRONG_BEARISH";
		} else if (currentPrice < effectiveSma20 && effectiveRsi <= 50) {
			trendRating = "BEARISH";
		}
	}

	return {
		price: Number(currentPrice.toFixed(2)),
		indicators: {
			sma: {
				sma20: latestSma20 ? Number(latestSma20.toFixed(2)) : null,
				sma50: latestSma50 ? Number(latestSma50.toFixed(2)) : null,
				sma200: latestSma200 ? Number(latestSma200.toFixed(2)) : null,
			},
			ema: {
				ema9: latestEma9 ? Number(latestEma9.toFixed(2)) : null,
				ema20: latestEma20 ? Number(latestEma20.toFixed(2)) : null,
			},
			rsi: latestRsi ? Number(latestRsi.toFixed(2)) : null,
			macd: latestMacd
				? {
						macd: latestMacd.MACD ? Number(latestMacd.MACD.toFixed(2)) : null,
						signal: latestMacd.signal
							? Number(latestMacd.signal.toFixed(2))
							: null,
						histogram: latestMacd.histogram
							? Number(latestMacd.histogram.toFixed(2))
							: null,
					}
				: null,
			bollingerBands: latestBb
				? {
						upper: latestBb.upper ? Number(latestBb.upper.toFixed(2)) : null,
						middle: latestBb.middle ? Number(latestBb.middle.toFixed(2)) : null,
						lower: latestBb.lower ? Number(latestBb.lower.toFixed(2)) : null,
					}
				: null,
			atr: latestAtr ? Number(latestAtr.toFixed(2)) : null,
		},
		implication: {
			trendRating,
			rationale: `Price is at ${currentPrice.toFixed(2)} relative to 20 SMA (${effectiveSma20 ? effectiveSma20.toFixed(2) : "N/A"}) and 50 SMA (${effectiveSma50 ? effectiveSma50.toFixed(2) : "N/A"}), with RSI at ${effectiveRsi ? effectiveRsi.toFixed(2) : "N/A"}.`,
		},
	};
}
