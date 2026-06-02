import { z } from "zod";
import { type UpstoxResponse, upstoxFetch } from "../clients/upstox.ts";
import { SIGNAL_CONFIG } from "../configs/signal-config.ts";
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
import { buildGreeksScenario, daysToExpiry } from "../helpers/blackscholes.ts";
import { evaluateSignalGates, selectOptimalStrike } from "../helpers/signal.ts";
import { server } from "../server.ts";

// --------------------------------------------------------------------------
// Lot sizes per instrument (NSE standard)
// --------------------------------------------------------------------------
const LOT_SIZES: Record<string, number> = {
	"NSE_INDEX|Nifty 50": SIGNAL_CONFIG.positionSizing.lotSizeNifty,
	"NSE_INDEX|Nifty Bank": SIGNAL_CONFIG.positionSizing.lotSizeBankNifty,
};

function getLotSize(instrumentKey: string): number {
	return LOT_SIZES[instrumentKey] ?? SIGNAL_CONFIG.positionSizing.lotSizeNifty;
}

// --------------------------------------------------------------------------
// Tool: get_master_signal
// --------------------------------------------------------------------------
server.registerTool(
	"get_master_signal",
	{
		description:
			"Master options signal engine. Runs all analysis (PCR, OI dynamics, volatility profile, technicals, strike selection, Greeks scenario) in parallel for a given instrument and expiry. Applies a rule-based gate system — mandatory gates, confirmation factors, and disqualifiers — to produce a single auditable signal with entry price, target, stop-loss, and risk-reward ratio. Designed for real-capital deployment.",
		inputSchema: z.object({
			instrument_key: z
				.string()
				.describe("Underlying instrument key (e.g. 'NSE_INDEX|Nifty 50')"),
			expiry_date: z.string().describe("Expiry date in YYYY-MM-DD format"),
			pcr_history: z
				.array(z.number())
				.optional()
				.describe(
					"Ordered PCR readings oldest→newest from session memory (used to compute intraday PCR trend momentum as a 5th confirmation factor). Pass the last 3–6 readings from .antigravity/context/session-state.json.",
				),
		}),
	},
	async (args) => {
		const { instrument_key, expiry_date, pcr_history } = args;
		const polledAt = new Date().toLocaleString("en-IN", {
			timeZone: "Asia/Kolkata",
			hour12: false,
		});

		try {
			// ── Parallel fetch: option chain + OI dynamics + candles ──────────
			const today = new Date();
			const todayStr = today.toISOString().split("T")[0] as string;
			const thirtyDaysAgo = new Date(today);
			thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
			const fromDateStr = thirtyDaysAgo.toISOString().split("T")[0] as string;

			const [chainResponse, changeOiResponse, candleResponse] =
				await Promise.all([
					upstoxFetch<OptionChainResponse>("/v2/option/chain", "GET", {
						instrument_key,
						expiry_date,
					}),
					upstoxFetch<UpstoxResponse<ChangeOIData>>(
						"/v2/market/change-oi",
						"GET",
						{
							instrument_key,
							expiry: expiry_date,
							date: todayStr,
							interval: 1,
						},
					),
					upstoxFetch<UpstoxResponse<{ candles: RawCandleArray[] }>>(
						`/v2/historical-candle/${encodeURIComponent(instrument_key)}/30minute/${todayStr}/${fromDateStr}`,
						"GET",
					),
				]);

			const chainEntries = chainResponse.data ?? [];
			if (chainEntries.length === 0) {
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify(
								{
									instrument_key,
									expiry_date,
									polledAt,
									direction: "NO_TRADE",
									conviction: "NO_TRADE",
									noTradeReason:
										"No option chain data available for this expiry",
								},
								null,
								2,
							),
						},
					],
				};
			}

			const spotPrice = chainEntries[0]?.underlying_spot_price ?? 0;

			// ── Run all analysis on fetched data ──────────────────────────────
			const activeOI = analyzeActiveOI(chainEntries);
			const pcr = calculatePCR(chainEntries);
			const maxPain = calculateMaxPain(chainEntries);
			const volatility = calculateVolatilityProfile(chainEntries);
			const recommendation = generateRecommendation(
				spotPrice,
				activeOI.resistance,
				activeOI.support,
				pcr,
				maxPain,
			);

			const changeOiEntries =
				changeOiResponse.data?.call_put_oi_data_list ?? [];
			const oiDynamicsRaw = analyzeOIDynamics(changeOiEntries);
			const candles = candleResponse.data?.candles ?? [];
			const technicals = calculateTechnicalIndicators(candles);

			const atmIV = volatility?.atmProfile.atmIV ?? 0;

			// ── Classify IV environment ────────────────────────────────────────
			let ivEnvironment: "CHEAP" | "FAIR" | "EXPENSIVE" = "FAIR";
			if (atmIV > 0) {
				if (atmIV < SIGNAL_CONFIG.iv.cheap) ivEnvironment = "CHEAP";
				else if (atmIV > SIGNAL_CONFIG.iv.expensive)
					ivEnvironment = "EXPENSIVE";
			}

			// ── Run signal gate evaluation ─────────────────────────────────────
			const gates = evaluateSignalGates({
				spotPrice,
				maxPain,
				pcr,
				oiDynamics: { summary: oiDynamicsRaw.summary },
				technicals,
				volatility: volatility
					? { atmProfile: { atmIV: volatility.atmProfile.atmIV } }
					: null,
				activeOI,
				targetContractType: recommendation.targetContractType,
				pcrHistory: pcr_history,
			});

			// ── Build base signal (no entry yet) ───────────────────────────────
			const lotSize = getLotSize(instrument_key);

			const baseSignal = {
				instrument_key,
				expiry_date,
				polledAt,
				spotPrice: Number(spotPrice.toFixed(2)),
				direction: gates.direction,
				conviction: gates.conviction,
				noTradeReason:
					gates.conviction === "NO_TRADE"
						? (gates.disqualifyReason ?? gates.mandatoryReason)
						: null,
				gates: {
					mandatoryPassed: gates.mandatoryPassed,
					mandatoryReason: gates.mandatoryReason,
					confirmationsHit: gates.confirmationsHit,
					confirmationCount: gates.confirmationCount,
					disqualified: gates.disqualified,
					disqualifyReason: gates.disqualifyReason,
				},
				pcr: {
					value: pcr.pcr,
					bias: pcr.bias,
					interpretation: pcr.interpretation,
				},
				oiDynamics: {
					trendShifting: oiDynamicsRaw.summary.trendShifting,
					totalCallChange: oiDynamicsRaw.summary.totalCallChange,
					totalPutChange: oiDynamicsRaw.summary.totalPutChange,
					shiftRatio: oiDynamicsRaw.summary.shiftRatio,
					peaks: oiDynamicsRaw.peaks,
				},
				technicals: technicals
					? {
							trendRating: technicals.implication.trendRating,
							rsi: technicals.indicators.rsi,
							macd: technicals.indicators.macd,
							sma20: technicals.indicators.sma.sma20,
							sma50: technicals.indicators.sma.sma50,
							atr: technicals.indicators.atr,
						}
					: null,
				volatility: volatility
					? {
							atmIV: volatility.atmProfile.atmIV,
							fearGauge: volatility.skewMetrics.skewImplication,
							skew: volatility.skewMetrics.skew,
							ivEnvironment,
						}
					: null,
				keyLevels: {
					resistance: activeOI.resistance.strike,
					resistanceOI: activeOI.resistance.oi,
					support: activeOI.support.strike,
					supportOI: activeOI.support.oi,
					maxPain,
				},
				recommendation: {
					action: recommendation.action,
					strategyName: recommendation.strategyName,
					targetContractType: recommendation.targetContractType,
					rationale: recommendation.rationale,
				},
				entry: null as null | object,
				riskReward: null as null | object,
				positionSizing: {
					suggestedMaxLots:
						gates.conviction === "HIGH" && ivEnvironment === "CHEAP"
							? SIGNAL_CONFIG.positionSizing.lotsHighConvictionCheapIV
							: SIGNAL_CONFIG.positionSizing.lotsDefault,
					lotSize,
					note: "These are maximums. Never risk more than 2% of capital on a single options position.",
				},
			};

			// ── If NO_TRADE, return early ──────────────────────────────────────
			if (gates.conviction === "NO_TRADE") {
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify(baseSignal, null, 2),
						},
					],
				};
			}

			// ── Strike selection ───────────────────────────────────────────────
			const strikeSelection = selectOptimalStrike(
				chainEntries,
				gates.direction as "BULLISH" | "BEARISH",
				atmIV,
				expiry_date,
			);

			if (!strikeSelection) {
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify(
								{
									...baseSignal,
									conviction: "NO_TRADE",
									noTradeReason:
										"No qualifying strike found — insufficient liquidity",
								},
								null,
								2,
							),
						},
					],
				};
			}

			baseSignal.entry = {
				selectedStrike: strikeSelection.selectedStrike,
				instrumentKey: strikeSelection.instrumentKey,
				optionType: strikeSelection.optionType,
				entryPremium: strikeSelection.ltp,
				delta: strikeSelection.delta,
				iv: strikeSelection.iv,
				oi: strikeSelection.oi,
				volume: strikeSelection.volume,
				daysToExpiry: daysToExpiry(expiry_date),
				liquidityWarning: strikeSelection.liquidityWarning,
			};

			// ── Greeks scenario for R:R ────────────────────────────────────────
			const annualIV = strikeSelection.iv / 100;
			const cfg = SIGNAL_CONFIG.greeksScenario;
			const shiftPct = cfg.spotShiftPct / 100;

			const scenarioTable = buildGreeksScenario(
				strikeSelection.selectedStrike,
				expiry_date,
				annualIV,
				spotPrice * (1 - shiftPct),
				spotPrice * (1 + shiftPct),
				20,
			);

			if (scenarioTable.length > 0) {
				const isCall = strikeSelection.optionType === "call";
				const getPrice = (pt: (typeof scenarioTable)[0]) =>
					isCall ? pt.callPrice : pt.putPrice;

				// For calls: target = spot up, stop = spot down.
				// For puts: target = spot down, stop = spot up — flip the signs.
				const dirMult = isCall ? 1 : -1;
				const targetSpot = spotPrice * (1 + (dirMult * cfg.targetShiftPct) / 100);
				const stopSpot = spotPrice * (1 + (dirMult * cfg.stopShiftPct) / 100);

				const nearest = (targetS: number) =>
					scenarioTable.reduce((best, pt) =>
						Math.abs(pt.spot - targetS) < Math.abs(best.spot - targetS)
							? pt
							: best,
					);

				const targetPoint = nearest(targetSpot);
				const stopPoint = nearest(stopSpot);
				// Use BS price at current spot as R:R baseline so entry/target/stop
				// are all from the same model. Market LTP stays in baseSignal.entry.
				const bsEntryPrice = getPrice(nearest(spotPrice));
				const targetPremium = getPrice(targetPoint);
				const stopPremium = getPrice(stopPoint);

				const gain = targetPremium - bsEntryPrice;
				const loss = bsEntryPrice - stopPremium;
				const ratio = loss > 0 ? Number((gain / loss).toFixed(2)) : 0;
				const belowMinimum = ratio < SIGNAL_CONFIG.riskReward.minimumRatio;

				// Downgrade conviction if R:R is insufficient
				if (belowMinimum && baseSignal.conviction === "HIGH") {
					baseSignal.conviction = "MEDIUM";
				}

				baseSignal.riskReward = {
					targetPremium: Number(targetPremium.toFixed(2)),
					targetSpotMove: `+${cfg.targetShiftPct}%`,
					stopPremium: Number(stopPremium.toFixed(2)),
					stopSpotMove: `${cfg.stopShiftPct}%`,
					ratio,
					belowMinimum,
					...(belowMinimum && {
						warning: `R:R ratio ${ratio} is below minimum ${SIGNAL_CONFIG.riskReward.minimumRatio} — conviction downgraded`,
					}),
				};
			}

			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify(baseSignal, null, 2),
					},
				],
			};
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify(
							{
								instrument_key,
								expiry_date,
								polledAt,
								direction: "NO_TRADE",
								conviction: "NO_TRADE",
								noTradeReason: `Data fetch error: ${message}`,
							},
							null,
							2,
						),
					},
				],
				isError: true,
			};
		}
	},
);
