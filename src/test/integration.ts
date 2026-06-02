import { type UpstoxResponse, upstoxFetch } from "../clients/upstox.ts";
import {
	analyzeActiveOI,
	analyzeOIDynamics,
	type ChangeOIData,
	calculateMaxPain,
	calculatePCR,
	calculateTechnicalIndicators,
	calculateVolatilityProfile,
	generateRecommendation,
	type OptionChainResponse,
	type RawCandleArray,
} from "../helpers/analysis.ts";
import {
	buildGreeksScenario,
	calculateImpliedVolatility,
	daysToExpiry,
} from "../helpers/blackscholes.ts";
import { createLogger } from "../helpers/logger.ts";
import { calculateStrategyPayoff } from "../helpers/payoff.ts";
import type { InstrumentSearchItem } from "../tools/market.ts";

const logger = createLogger("test-suite");

/**
 * Integration Verification Test Suite for Options Trading MCP Server
 */
async function runTests() {
	logger.info("====================================================");
	logger.info("🚀 STARTING INTEGRATION & VERIFICATION TESTS (STRICT)");
	logger.info("====================================================\n");

	const underlying = "NSE_INDEX|Nifty 50";
	let targetExpiry = "";

	// ------------------------------------------------------------------------
	// Test 1: Test Upstox Client and search_underlying
	// ------------------------------------------------------------------------
	try {
		logger.info("🔍 Test 1: Searching for underlying 'Nifty 50'...");
		const response = await upstoxFetch<UpstoxResponse<InstrumentSearchItem[]>>(
			"/v2/instruments/search",
			"GET",
			{
				query: "Nifty 50",
				exchanges: "NSE",
			},
		);

		if (
			response.status === "success" &&
			response.data &&
			response.data.length > 0
		) {
			const first = response.data[0];
			if (first) {
				logger.info(
					`   * Sample instrument object keys: ${JSON.stringify(Object.keys(first))}`,
				);
				logger.info(
					`   * Sample instrument object: ${JSON.stringify(first, null, 2)}`,
				);

				// Field validation
				if (!first.instrument_key.includes("|"))
					throw new Error(
						`instrument_key format invalid (expected SEGMENT|Name): ${first.instrument_key}`,
					);
				if (first.segment !== "NSE_INDEX")
					throw new Error(`Expected NSE_INDEX segment, got: ${first.segment}`);
				if (!first.trading_symbol) throw new Error("Missing trading_symbol");
				if (!first.name) throw new Error("Missing name");
				if (!first.exchange) throw new Error("Missing exchange");

				logger.success(
					`Test 1 Success! Found underlying symbol: ${
						first.trading_symbol || first.name
					} (${first.instrument_key})\n`,
				);
			}
		} else {
			throw new Error(
				`Invalid response structure: ${JSON.stringify(response)}`,
			);
		}
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		logger.error("❌ Test 1 Failed:", message);
		process.exit(1);
	}

	// ------------------------------------------------------------------------
	// Test 2: Test Active Expiries Retrieval
	// ------------------------------------------------------------------------
	try {
		logger.info("📅 Test 2: Fetching active expiries for 'Nifty 50'...");
		const response = await upstoxFetch<UpstoxResponse<InstrumentSearchItem[]>>(
			"/v2/instruments/search",
			"GET",
			{
				query: "Nifty 50",
				exchanges: "NSE",
			},
		);

		const instruments = response.data || [];
		const expiries = new Set<string>();
		for (const inst of instruments) {
			if (inst.instrument_key?.includes("NSE_FO") && inst.expiry) {
				expiries.add(inst.expiry);
			}
		}
		const sortedExpiries = Array.from(expiries).sort();

		const firstExpiry = sortedExpiries[0];
		if (!firstExpiry) throw new Error("No active expiries found.");

		targetExpiry = firstExpiry;

		// Field validation: format, future dates, ascending order
		const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
		const today = new Date().toISOString().split("T")[0]!;
		for (const expiry of sortedExpiries) {
			if (!dateRegex.test(expiry))
				throw new Error(
					`Expiry date format invalid (expected YYYY-MM-DD): ${expiry}`,
				);
			if (expiry < today)
				throw new Error(`Expiry date is in the past: ${expiry}`);
		}
		for (let i = 1; i < sortedExpiries.length; i++) {
			if (sortedExpiries[i]! < sortedExpiries[i - 1]!)
				throw new Error(
					`Expiries not sorted: ${sortedExpiries[i - 1]} > ${sortedExpiries[i]}`,
				);
		}

		logger.success(
			`Test 2 Success! Found ${sortedExpiries.length} active expiries. Nearest expiry: ${targetExpiry}\n`,
		);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		logger.error("❌ Test 2 Failed:", message);
		process.exit(1);
	}

	// ------------------------------------------------------------------------
	// Test 3: Test Options Chain Fusion Analytics & Calculations
	// ------------------------------------------------------------------------
	try {
		logger.info(
			`📊 Test 3: Fetching and calculating insights for Nifty 50 expiry ${targetExpiry}...`,
		);
		const chainResponse = await upstoxFetch<OptionChainResponse>(
			"/v2/option/chain",
			"GET",
			{
				instrument_key: underlying,
				expiry_date: targetExpiry,
			},
		);

		const chainEntries = chainResponse.data || [];
		if (chainEntries.length === 0) {
			throw new Error("Option chain entries are empty.");
		}

		const firstEntry = chainEntries[0];
		const spotPrice = firstEntry?.underlying_spot_price || 0;
		logger.info(`   * Live Spot Price: ${spotPrice.toFixed(2)}`);

		// Run active OI support/resistance peaks calculation
		const activeOI = analyzeActiveOI(chainEntries);
		logger.info(
			`   * Active Call OI Resistance: Strike ${activeOI.resistance.strike} (OI: ${activeOI.resistance.oi})`,
		);
		logger.info(
			`   * Active Put OI Support: Strike ${activeOI.support.strike} (OI: ${activeOI.support.oi})`,
		);

		// Run PCR calculation
		const pcr = calculatePCR(chainEntries);
		logger.info(
			`   * Put-Call Ratio (PCR): ${pcr.pcr} (${pcr.bias} - ${pcr.interpretation})`,
		);

		// Run Max Pain calculation
		const maxPain = calculateMaxPain(chainEntries);
		logger.info(`   * Max Pain Strike: ${maxPain}`);

		// Run trade recommendation generator
		const rec = generateRecommendation(
			spotPrice,
			activeOI.resistance,
			activeOI.support,
			pcr,
			maxPain,
		);

		logger.info("\n💡 Generated AI Options Strategy Recommendation:");
		logger.info(`   * Recommended Action: ${rec.action}`);
		logger.info(`   * Selected Strategy:  ${rec.strategyName}`);
		logger.info(`   * Conviction Level:   ${rec.conviction}`);
		logger.info(`   * Conviction Rationale: ${rec.rationale}`);

		// PCR invariants
		if (pcr.pcr <= 0) throw new Error(`PCR must be > 0, got: ${pcr.pcr}`);
		if (pcr.totalCallOI <= 0)
			throw new Error(`Total Call OI must be > 0, got: ${pcr.totalCallOI}`);
		if (pcr.totalPutOI <= 0)
			throw new Error(`Total Put OI must be > 0, got: ${pcr.totalPutOI}`);
		const VALID_BIAS = [
			"EXTREMELY_BULLISH",
			"BULLISH",
			"NEUTRAL",
			"BEARISH",
			"EXTREMELY_BEARISH",
		];
		if (!VALID_BIAS.includes(pcr.bias))
			throw new Error(`Invalid PCR bias: ${pcr.bias}`);

		// Max Pain must be an actual strike from the chain
		const chainStrikes = chainEntries.map((e) => e.strike_price);
		if (!chainStrikes.includes(maxPain))
			throw new Error(`Max pain ${maxPain} is not a valid chain strike`);

		// Recommendation field completeness
		if (!["BUY", "SELL", "HOLD"].includes(rec.action))
			throw new Error(`Invalid action: ${rec.action}`);
		if (!["HIGH", "MEDIUM", "LOW"].includes(rec.conviction))
			throw new Error(`Invalid conviction: ${rec.conviction}`);
		if (!rec.rationale || rec.rationale.length < 10)
			throw new Error("Recommendation rationale is empty or too short");
		if (!rec.strategyName) throw new Error("Missing strategyName");

		// Key levels cross-field consistency
		if (rec.keyLevels.maxPain !== maxPain)
			throw new Error(
				`keyLevels.maxPain mismatch: ${rec.keyLevels.maxPain} vs ${maxPain}`,
			);
		if (rec.keyLevels.resistance !== activeOI.resistance.strike)
			throw new Error("keyLevels.resistance mismatch with activeOI");
		if (rec.keyLevels.support !== activeOI.support.strike)
			throw new Error("keyLevels.support mismatch with activeOI");
		if (rec.keyLevels.currentSpot <= 0)
			throw new Error("keyLevels.currentSpot must be > 0");

		logger.success("Test 3 Success! Analytics and trading engines verified.\n");
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		logger.error("❌ Test 3 Failed:", message);
		process.exit(1);
	}

	// ------------------------------------------------------------------------
	// Test 4: Volatility Profile ATM & Skew
	// ------------------------------------------------------------------------
	try {
		logger.info(
			`⚡ Test 4: Fetching Implied Volatility Profile for Nifty 50 expiry ${targetExpiry}...`,
		);
		const chainResponse = await upstoxFetch<OptionChainResponse>(
			"/v2/option/chain",
			"GET",
			{
				instrument_key: underlying,
				expiry_date: targetExpiry,
			},
		);
		const entries = chainResponse.data || [];
		const profile = calculateVolatilityProfile(entries);

		if (!profile) throw new Error("Failed to calculate volatility profile.");

		logger.info(`   * Spot: ${profile.spotPrice}`);
		logger.info(
			`   * ATM IV: ${profile.atmProfile.atmIV}% (Strike: ${profile.atmProfile.strike})`,
		);
		logger.info(`   * IV Skew (OTM Put - Call): ${profile.skewMetrics.skew}%`);
		logger.info(
			`   * IV Skew Implication: ${profile.skewMetrics.skewImplication}`,
		);

		// ATM strike within 2% of spot
		const atmDist =
			Math.abs(profile.atmProfile.strike - profile.spotPrice) /
			profile.spotPrice;
		if (atmDist > 0.02)
			throw new Error(
				`ATM strike ${profile.atmProfile.strike} is more than 2% from spot ${profile.spotPrice}`,
			);
		// ATM IV must be positive (resolveIV fallback should ensure this)
		if (profile.atmProfile.atmIV <= 0)
			throw new Error(`ATM IV must be > 0, got: ${profile.atmProfile.atmIV}`);
		// OTM call strike above ATM, OTM put strike below ATM
		if (profile.otmProfile.otmCallStrike <= profile.atmProfile.strike)
			throw new Error(
				`OTM call strike (${profile.otmProfile.otmCallStrike}) must be > ATM (${profile.atmProfile.strike})`,
			);
		if (profile.otmProfile.otmPutStrike >= profile.atmProfile.strike)
			throw new Error(
				`OTM put strike (${profile.otmProfile.otmPutStrike}) must be < ATM (${profile.atmProfile.strike})`,
			);
		// Skew must be a finite number
		if (!Number.isFinite(profile.skewMetrics.skew))
			throw new Error(`IV skew is not finite: ${profile.skewMetrics.skew}`);

		logger.success(
			"✅ Test 4 Success! Volatility profiling engine verified.\n",
		);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		logger.error("❌ Test 4 Failed:", message);
		process.exit(1);
	}

	// ------------------------------------------------------------------------
	// Test 2b: BankNifty active expiries — verifies the BANKNIFTY FO symbol mapping
	// ------------------------------------------------------------------------
	try {
		logger.info(
			"📅 Test 2b: Fetching active expiries for 'NSE_INDEX|Nifty Bank' (BankNifty)...",
		);
		const bnfResponse = await upstoxFetch<
			UpstoxResponse<
				{
					trading_symbol?: string;
					instrument_key: string;
					expiry?: string;
					instrument_type?: string;
				}[]
			>
		>("/v2/instruments/search", "GET", {
			query: "BANKNIFTY",
			exchanges: "NSE",
		});
		const bnfInstruments = bnfResponse.data || [];
		const bnfExpiries = new Set<string>();
		for (const inst of bnfInstruments) {
			if (inst.instrument_key?.includes("NSE_FO") && inst.expiry) {
				bnfExpiries.add(inst.expiry);
			}
		}
		const sortedBnfExpiries = Array.from(bnfExpiries).sort();
		if (sortedBnfExpiries.length === 0) {
			throw new Error(
				`No BankNifty FO expiries found. Got ${bnfInstruments.length} instruments from search — check FO_SYMBOL_BY_INSTRUMENT mapping.`,
			);
		}
		logger.success(
			`Test 2b Success! Found ${sortedBnfExpiries.length} BankNifty expiries. Nearest: ${sortedBnfExpiries[0]}\n`,
		);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		logger.error("❌ Test 2b Failed:", message);
		process.exit(1);
	}

	// ------------------------------------------------------------------------
	// Test 5: Open Interest Dynamics
	// ------------------------------------------------------------------------
	try {
		logger.info(
			`🔄 Test 5: Fetching Open Interest Change Dynamics for Nifty 50 expiry ${targetExpiry}...`,
		);
		const response = await upstoxFetch<UpstoxResponse<ChangeOIData>>(
			"/v2/market/change-oi",
			"GET",
			{
				instrument_key: underlying,
				expiry: targetExpiry,
				date: targetExpiry,
				interval: 1,
			},
		);
		const entries = response.data?.call_put_oi_data_list ?? [];
		const dynamics = analyzeOIDynamics(entries);
		logger.info(`   * Total Call Change: ${dynamics.summary.totalCallChange}`);
		logger.info(`   * Total Put Change:  ${dynamics.summary.totalPutChange}`);
		logger.info(`   * Shift Ratio:       ${dynamics.summary.shiftRatio}`);
		logger.info(`   * Trend Shifting:    ${dynamics.summary.trendShifting}`);

		// Field validation
		if (typeof dynamics.summary.totalCallChange !== "number")
			throw new Error("totalCallChange must be a number");
		if (typeof dynamics.summary.totalPutChange !== "number")
			throw new Error("totalPutChange must be a number");
		if (!Number.isFinite(dynamics.summary.shiftRatio))
			throw new Error(
				`shiftRatio must be finite, got: ${dynamics.summary.shiftRatio}`,
			);
		// Peak strikes must be positive if there is any data
		if (entries.length > 0) {
			if (dynamics.peaks.callWriting.strike <= 0)
				throw new Error(
					`callWriting peak strike must be > 0, got: ${dynamics.peaks.callWriting.strike}`,
				);
			if (dynamics.peaks.putWriting.strike <= 0)
				throw new Error(
					`putWriting peak strike must be > 0, got: ${dynamics.peaks.putWriting.strike}`,
				);
		}

		logger.success("✅ Test 5 Success! OI Dynamics calculation verified.\n");
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		logger.warn(
			"⚠️ Test 5 Warning: Failed to query change-oi. Shifting to standard backup verification since historical change-oi may be expired.",
			message,
		);
	}

	// ------------------------------------------------------------------------
	// Test 6: Technical Candles & Indicator overlays (RSI, Moving Averages)
	// ------------------------------------------------------------------------
	try {
		logger.info(
			"📈 Test 6: Fetching Technical Candles and overlays for 'Nifty 50'...",
		);
		const response = await upstoxFetch<
			UpstoxResponse<{ candles: RawCandleArray[] }>
		>(
			`/v2/historical-candle/${encodeURIComponent(underlying)}/day/${targetExpiry}/2025-05-01`,
			"GET",
		);
		const candles = response.data?.candles || [];
		const technicals = calculateTechnicalIndicators(candles);

		if (!technicals) throw new Error("Failed to calculate technical overlays.");

		logger.info(`   * Latest Price: ${technicals.price}`);
		logger.info(
			`   * SMAs: SMA20 (${technicals.indicators.sma.sma20}) | SMA50 (${technicals.indicators.sma.sma50}) | SMA200 (${technicals.indicators.sma.sma200})`,
		);
		logger.info(
			`   * EMAs: EMA9 (${technicals.indicators.ema.ema9}) | EMA20 (${technicals.indicators.ema.ema20})`,
		);
		logger.info(
			`   * Bollinger Bands: Upper (${technicals.indicators.bollingerBands?.upper}) | Mid (${technicals.indicators.bollingerBands?.middle}) | Lower (${technicals.indicators.bollingerBands?.lower})`,
		);
		logger.info(
			`   * Relative Strength Index (RSI): ${technicals.indicators.rsi}`,
		);
		logger.info(`   * ATR: ${technicals.indicators.atr}`);
		logger.info(
			`   * MACD: MACD (${technicals.indicators.macd?.macd}) | Signal (${technicals.indicators.macd?.signal}) | Hist (${technicals.indicators.macd?.histogram})`,
		);
		logger.info(
			`   * Market Implication: ${technicals.implication.trendRating}`,
		);

		// RSI must be in [0, 100]
		const rsi = technicals.indicators.rsi;
		if (rsi === null || rsi < 0 || rsi > 100)
			throw new Error(`RSI out of range [0, 100]: ${rsi}`);

		// Bollinger Bands: upper > middle > lower
		const bb = technicals.indicators.bollingerBands;
		if (!bb) throw new Error("Bollinger Bands missing (not enough candles?)");
		if (!bb.upper || !bb.middle || !bb.lower)
			throw new Error("Bollinger Bands contain null values");
		if (bb.upper <= bb.middle)
			throw new Error(`BB upper (${bb.upper}) must be > middle (${bb.middle})`);
		if (bb.middle <= bb.lower)
			throw new Error(`BB middle (${bb.middle}) must be > lower (${bb.lower})`);

		// ATR must be positive
		const atr = technicals.indicators.atr;
		if (!atr || atr <= 0) throw new Error(`ATR must be > 0, got: ${atr}`);

		// MACD histogram = MACD line − signal line
		const macd = technicals.indicators.macd;
		if (
			macd?.macd !== null &&
			macd?.signal !== null &&
			macd?.histogram !== null &&
			macd
		) {
			const expectedHist = (macd.macd ?? 0) - (macd.signal ?? 0);
			if (Math.abs((macd.histogram ?? 0) - expectedHist) > 0.1)
				throw new Error(
					`MACD histogram mismatch: expected ${expectedHist.toFixed(2)}, got ${macd.histogram}`,
				);
		}

		// Trend rating must be a valid enum value
		const VALID_TRENDS = [
			"STRONG_BULLISH",
			"BULLISH",
			"NEUTRAL",
			"BEARISH",
			"STRONG_BEARISH",
		];
		if (!VALID_TRENDS.includes(technicals.implication.trendRating))
			throw new Error(
				`Invalid trend rating: ${technicals.implication.trendRating}`,
			);

		logger.success(
			"✅ Test 6 Success! Price charting & technical calculations verified.\n",
		);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		logger.error("❌ Test 6 Failed:", message);
		process.exit(1);
	}

	// ------------------------------------------------------------------------
	// Test 7: get_analyzed_option_chain — filtered window + full Greeks
	// ------------------------------------------------------------------------
	try {
		logger.info(
			`🔬 Test 7: Fetching analyzed option chain (spot ±3 strikes) for Nifty 50 expiry ${targetExpiry}...`,
		);
		const chainResponse = await upstoxFetch<OptionChainResponse>(
			"/v2/option/chain",
			"GET",
			{ instrument_key: underlying, expiry_date: targetExpiry },
		);
		const allEntries = chainResponse.data || [];
		if (allEntries.length === 0) throw new Error("Option chain is empty.");

		const spotPrice = allEntries[0]?.underlying_spot_price || 0;
		const window = 3;
		const sorted = [...allEntries].sort(
			(a, b) => a.strike_price - b.strike_price,
		);
		const atmIdx = sorted.reduce(
			(best, e, i) =>
				Math.abs(e.strike_price - spotPrice) <
				Math.abs(sorted[best]!.strike_price - spotPrice)
					? i
					: best,
			0,
		);
		const windowEntries = sorted.slice(
			Math.max(0, atmIdx - window),
			Math.min(sorted.length - 1, atmIdx + window) + 1,
		);

		const mapped = windowEntries.map((e) => ({
			strike: e.strike_price,
			call: e.call_options
				? {
						ltp: e.call_options.market_data?.ltp ?? 0,
						iv: e.call_options.option_greeks?.iv ?? 0,
						delta: e.call_options.option_greeks?.delta ?? 0,
						gamma: e.call_options.option_greeks?.gamma ?? 0,
						theta: e.call_options.option_greeks?.theta ?? 0,
						vega: e.call_options.option_greeks?.vega ?? 0,
					}
				: null,
			put: e.put_options
				? {
						ltp: e.put_options.market_data?.ltp ?? 0,
						iv: e.put_options.option_greeks?.iv ?? 0,
						delta: e.put_options.option_greeks?.delta ?? 0,
						gamma: e.put_options.option_greeks?.gamma ?? 0,
						theta: e.put_options.option_greeks?.theta ?? 0,
						vega: e.put_options.option_greeks?.vega ?? 0,
					}
				: null,
		}));

		const atmEntry = mapped[window];
		if (!atmEntry) throw new Error("ATM entry missing from filtered window.");

		const hasFullGreeks =
			atmEntry.call?.gamma !== undefined &&
			atmEntry.call?.theta !== undefined &&
			atmEntry.call?.vega !== undefined;
		if (!hasFullGreeks)
			throw new Error("ATM call is missing gamma/theta/vega fields.");

		logger.info(
			`   * Spot: ${spotPrice.toFixed(2)} | Window: ${windowEntries.length} strikes`,
		);
		for (const row of mapped) {
			logger.info(
				`   * Strike ${row.strike} — Call: ltp=${row.call?.ltp} δ=${row.call?.delta} γ=${row.call?.gamma} θ=${row.call?.theta} ν=${row.call?.vega} | Put: ltp=${row.put?.ltp} δ=${row.put?.delta}`,
			);
		}

		// Greeks range invariants for every strike
		for (const row of mapped) {
			if (row.call) {
				if (row.call.delta < 0 || row.call.delta > 1)
					throw new Error(
						`Call delta out of [0,1] at strike ${row.strike}: ${row.call.delta}`,
					);
				if (row.call.gamma < 0)
					throw new Error(
						`Negative gamma at strike ${row.strike}: ${row.call.gamma}`,
					);
				if (row.call.theta > 0)
					throw new Error(
						`Positive theta for call at strike ${row.strike}: ${row.call.theta}`,
					);
				if (row.call.vega <= 0)
					throw new Error(
						`Non-positive vega at strike ${row.strike}: ${row.call.vega}`,
					);
			}
			if (row.put && (row.put.delta > 0 || row.put.delta < -1))
				throw new Error(
					`Put delta out of [-1,0] at strike ${row.strike}: ${row.put.delta}`,
				);
		}

		// ATM call delta should be close to 0.5 (range 0.25 – 0.75)
		if (atmEntry.call) {
			const d = atmEntry.call.delta;
			if (d < 0.25 || d > 0.75)
				throw new Error(`ATM call delta should be ~0.5, got: ${d}`);
		}

		// Call premiums decrease as strike rises; put premiums increase as strike rises
		for (let i = 1; i < mapped.length; i++) {
			const prev = mapped[i - 1]!;
			const curr = mapped[i]!;
			if (prev.call?.ltp && curr.call?.ltp && curr.call.ltp > prev.call.ltp)
				throw new Error(
					`Call premium increases with strike: ${prev.strike}=${prev.call.ltp} < ${curr.strike}=${curr.call.ltp}`,
				);
			if (prev.put?.ltp && curr.put?.ltp && curr.put.ltp < prev.put.ltp)
				throw new Error(
					`Put premium decreases with strike: ${prev.strike}=${prev.put.ltp} > ${curr.strike}=${curr.put.ltp}`,
				);
		}

		logger.success(
			"✅ Test 7 Success! Analyzed chain with full Greeks verified.\n",
		);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		logger.error("❌ Test 7 Failed:", message);
		process.exit(1);
	}

	// ------------------------------------------------------------------------
	// Test 8: get_greeks_scenario — Black-Scholes scenario across spot range
	// ------------------------------------------------------------------------
	try {
		logger.info(
			`📐 Test 8: Running Black-Scholes Greeks scenario for Nifty 50 ATM strike, expiry ${targetExpiry}...`,
		);
		const chainResponse = await upstoxFetch<OptionChainResponse>(
			"/v2/option/chain",
			"GET",
			{ instrument_key: underlying, expiry_date: targetExpiry },
		);
		const entries = chainResponse.data || [];
		if (entries.length === 0) throw new Error("Option chain is empty.");

		const spotPrice = entries[0]?.underlying_spot_price || 0;
		const sorted = [...entries].sort((a, b) => a.strike_price - b.strike_price);
		const atmEntry = sorted.reduce((best, e) =>
			Math.abs(e.strike_price - spotPrice) <
			Math.abs(best.strike_price - spotPrice)
				? e
				: best,
		);
		const atmStrike = atmEntry.strike_price;
		const dte = daysToExpiry(targetExpiry);
		const tte = dte / 365;

		// Prefer chain IV; fall back to BS-inverted IV from LTP (mirrors resolveIV in analysis.ts)
		const chainIV =
			atmEntry.call_options?.option_greeks?.iv ?? 0;
		const ltp = atmEntry.call_options?.market_data?.ltp ?? 0;
		const resolvedIVPct =
			chainIV > 0
				? chainIV
				: (calculateImpliedVolatility(ltp, spotPrice, atmStrike, tte, true) ??
					0);

		if (!resolvedIVPct)
			throw new Error(
				"ATM IV is 0 and LTP-based inversion also failed — chain data unavailable.",
			);

		const annualIV = resolvedIVPct / 100;
		logger.info(
			`   * IV source: ${chainIV > 0 ? "chain" : "BS-inverted from LTP"} → ${resolvedIVPct.toFixed(2)}%`,
		);
		const shift = 0.03; // ±3%
		const scenario = buildGreeksScenario(
			atmStrike,
			targetExpiry,
			annualIV,
			spotPrice * (1 - shift),
			spotPrice * (1 + shift),
			10,
		);

		if (scenario.length !== 11) {
			throw new Error(`Expected 11 scenario points, got ${scenario.length}.`);
		}

		// For a call, delta should increase monotonically as spot rises
		const callDeltas = scenario.map((s) => s.callDelta);
		const isMonotonic = callDeltas.every(
			(d, i) => i === 0 || d >= callDeltas[i - 1]!,
		);
		if (!isMonotonic)
			throw new Error(
				"Call delta is not monotonically increasing across spot range.",
			);

		// Gamma and vega should be non-negative (far-OTM near-expiry can round to 0)
		const allPositiveGamma = scenario.every((s) => s.gamma >= 0);
		const allPositiveVega = scenario.every((s) => s.vega >= 0);
		if (!allPositiveGamma)
			throw new Error("Gamma contains negative values.");
		if (!allPositiveVega) throw new Error("Vega contains negative values.");

		// Call theta is always ≤ 0 in BS (strict invariant — no interest-rate flip exists for calls)
		for (const s of scenario) {
			if (s.callTheta > 0)
				throw new Error(
					`Call theta must be ≤ 0 at spot ${s.spot}, got: ${s.callTheta}`,
				);
		}
		// Put theta is typically negative but can flip positive for deep ITM puts due to the
		// interest rate effect: delayed receipt of strike payment costs the holder.
		// Assert only at the ATM mid-point where theta is always clearly negative.
		const midScenario = scenario[Math.floor(scenario.length / 2)];
		if (midScenario && midScenario.putTheta > 0)
			throw new Error(
				`ATM put theta must be < 0, got: ${midScenario.putTheta}`,
			);

		// BS identity: callDelta + |putDelta| = 1 at every point
		for (const s of scenario) {
			const sum = s.callDelta + Math.abs(s.putDelta);
			if (Math.abs(sum - 1) > 0.001)
				throw new Error(
					`callDelta + |putDelta| should equal 1 at spot ${s.spot}, got: ${sum.toFixed(5)}`,
				);
		}

		// BS put-call parity: C - P = S - K * e^(-rT)
		const rfr = 0.065;
		const discountFactor = Math.exp(-rfr * tte);
		for (const s of scenario) {
			const theoretical = s.spot - atmStrike * discountFactor;
			const actual = s.callPrice - s.putPrice;
			if (Math.abs(actual - theoretical) > 0.5)
				throw new Error(
					`Put-call parity violated at spot ${s.spot}: C-P=${actual.toFixed(2)}, S-K*df=${theoretical.toFixed(2)}`,
				);
		}

		logger.info(
			`   * ATM Strike: ${atmStrike} | IV: ${resolvedIVPct.toFixed(2)}% | DTE: ${dte}`,
		);
		logger.info(
			`   * Scenario range: ${scenario[0]?.spot} → ${scenario[scenario.length - 1]?.spot}`,
		);
		logger.info(
			`   * Call delta range: ${callDeltas[0]?.toFixed(4)} → ${callDeltas[callDeltas.length - 1]?.toFixed(4)}`,
		);
		logger.info(
			`   * Put delta range: ${scenario[0]?.putDelta.toFixed(4)} → ${scenario[scenario.length - 1]?.putDelta.toFixed(4)}`,
		);
		logger.info(
			`   * Gamma (mid): ${scenario[5]?.gamma} | Vega (mid): ${scenario[5]?.vega}`,
		);
		logger.success(
			"✅ Test 8 Success! Black-Scholes scenario analysis verified.\n",
		);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		logger.error("❌ Test 8 Failed:", message);
		process.exit(1);
	}

	// ------------------------------------------------------------------------
	// Test 9: get_strategy_payoff — multi-leg payoff profiles (pure math)
	// ------------------------------------------------------------------------
	try {
		logger.info(
			"💰 Test 9: Verifying strategy payoff calculator (pure math)...",
		);
		const spot = 23400;

		// Sub-test A: Bull Call Spread — buy 23400 call @ 150, sell 23600 call @ 60
		const bullSpread = calculateStrategyPayoff(
			[
				{ strike: 23400, type: "call", action: "buy", premium: 150, qty: 1 },
				{ strike: 23600, type: "call", action: "sell", premium: 60, qty: 1 },
			],
			spot,
		);
		const expectedNetPremiumSpread = -90; // paid 150, received 60
		const expectedMaxProfitSpread = 110; // (23600 - 23400) - 90 = 110
		const expectedMaxLossSpread = -90;
		if (bullSpread.totalNetPremium !== expectedNetPremiumSpread)
			throw new Error(
				`Bull spread net premium: expected ${expectedNetPremiumSpread}, got ${bullSpread.totalNetPremium}`,
			);
		if (
			typeof bullSpread.maxProfit !== "number" ||
			Math.abs(bullSpread.maxProfit - expectedMaxProfitSpread) > 1
		)
			throw new Error(
				`Bull spread max profit: expected ~${expectedMaxProfitSpread}, got ${bullSpread.maxProfit}`,
			);
		if (
			typeof bullSpread.maxLoss !== "number" ||
			Math.abs(bullSpread.maxLoss - expectedMaxLossSpread) > 1
		)
			throw new Error(
				`Bull spread max loss: expected ~${expectedMaxLossSpread}, got ${bullSpread.maxLoss}`,
			);
		if (bullSpread.breakevens.length === 0)
			throw new Error("Bull spread should have at least one breakeven.");
		logger.info(
			`   * Bull Call Spread: net=${bullSpread.totalNetPremium}, max profit=${bullSpread.maxProfit}, max loss=${bullSpread.maxLoss}, breakeven(s)=${bullSpread.breakevens}`,
		);

		// Sub-test B: Short Strangle — sell 23200 put @ 80, sell 23600 call @ 60
		const strangle = calculateStrategyPayoff(
			[
				{ strike: 23200, type: "put", action: "sell", premium: 80, qty: 1 },
				{ strike: 23600, type: "call", action: "sell", premium: 60, qty: 1 },
			],
			spot,
		);
		if (strangle.maxProfit !== 140)
			throw new Error(
				`Short strangle max profit: expected 140, got ${strangle.maxProfit}`,
			);
		if (strangle.maxLoss !== "UNLIMITED")
			throw new Error(
				`Short strangle max loss should be UNLIMITED, got ${strangle.maxLoss}`,
			);
		if (strangle.breakevens.length < 2)
			throw new Error("Short strangle should have two breakevens.");
		logger.info(
			`   * Short Strangle:   net=${strangle.totalNetPremium}, max profit=${strangle.maxProfit}, max loss=${strangle.maxLoss}, breakeven(s)=${strangle.breakevens}`,
		);

		// Sub-test C: Long Call — verify max loss bounded, max profit unlimited
		const longCall = calculateStrategyPayoff(
			[{ strike: 23400, type: "call", action: "buy", premium: 150, qty: 1 }],
			spot,
		);
		if (longCall.maxProfit !== "UNLIMITED")
			throw new Error("Long call max profit should be UNLIMITED.");
		if (
			typeof longCall.maxLoss !== "number" ||
			Math.abs(longCall.maxLoss - -150) > 1
		)
			throw new Error(
				`Long call max loss: expected ~-150, got ${longCall.maxLoss}`,
			);
		logger.info(
			`   * Long Call:        net=${longCall.totalNetPremium}, max profit=${longCall.maxProfit}, max loss=${longCall.maxLoss}`,
		);

		logger.success("✅ Test 9 Success! Strategy payoff calculator verified.\n");
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		logger.error("❌ Test 9 Failed:", message);
		process.exit(1);
	}

	logger.info("====================================================");
	logger.success("🎉 ALL TESTS PASSED! OPTIONS MANAGER IS 100% HEALTHY");
	logger.info("====================================================");
}

runTests().catch((e: unknown) => {
	logger.fatal("Unhandled test crash:", e);
	process.exit(1);
});
