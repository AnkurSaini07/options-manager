import { z } from "zod";
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
import { server } from "../server.ts";

export interface InstrumentSearchItem {
	name?: string;
	segment?: string;
	exchange?: string;
	instrument_key: string;
	exchange_token?: string;
	trading_symbol?: string;
	instrument_type?: string;
	expiry?: string;
}

// Upstox FO trading symbols don't match index display names.
// e.g. "NSE_INDEX|Nifty Bank" → FO symbol "BANKNIFTY", not "Nifty Bank".
const FO_SYMBOL_BY_INSTRUMENT: Record<string, string> = {
	"NSE_INDEX|Nifty 50": "NIFTY",
	"NSE_INDEX|Nifty Bank": "BANKNIFTY",
	"NSE_INDEX|Nifty Financial Services": "FINNIFTY",
	"NSE_INDEX|NIFTY MID SELECT": "MIDCPNIFTY",
	"NSE_INDEX|NIFTY Next 50": "NIFTYNXT50",
};

// --------------------------------------------------------------------------
// Tool: search_underlying
// --------------------------------------------------------------------------
server.registerTool(
	"search_underlying",
	{
		description:
			"Search for underlying indices or equity shares (e.g. 'Nifty 50', 'Reliance') to retrieve their unique Upstox instrument keys.",
		inputSchema: z.object({
			query: z
				.string()
				.describe(
					"Trading symbol, index or query search (e.g. 'Nifty', 'INFY')",
				),
		}),
	},
	async (args) => {
		try {
			const response = await upstoxFetch<
				UpstoxResponse<InstrumentSearchItem[]>
			>("/v2/instruments/search", "GET", {
				query: args.query,
				exchanges: "NSE,BSE",
			});
			return {
				content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
			};
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return {
				content: [
					{ type: "text", text: JSON.stringify({ error: message }, null, 2) },
				],
				isError: true,
			};
		}
	},
);

// --------------------------------------------------------------------------
// Tool: get_active_expiries
// --------------------------------------------------------------------------
server.registerTool(
	"get_active_expiries",
	{
		description:
			"Retrieve list of all active upcoming options contract expiry dates for an underlying instrument.",
		inputSchema: z.object({
			instrument_key: z
				.string()
				.describe(
					"Underlying instrument key (e.g., 'NSE_INDEX|Nifty 50' or 'NSE_EQ|INE002A01018')",
				),
		}),
	},
	async (args) => {
		try {
			const searchQuery =
				FO_SYMBOL_BY_INSTRUMENT[args.instrument_key] ??
				(args.instrument_key.includes("|")
					? args.instrument_key.split("|")[1]
					: args.instrument_key);

			if (!searchQuery) {
				throw new Error("Invalid underlying instrument key format.");
			}

			const response = await upstoxFetch<
				UpstoxResponse<InstrumentSearchItem[]>
			>("/v2/instruments/search", "GET", {
				query: searchQuery,
				exchanges: "NSE",
			});

			const instruments = response.data || [];
			const expiries = new Set<string>();

			for (const inst of instruments) {
				if (inst.instrument_key?.includes("NSE_FO") && inst.expiry) {
					expiries.add(inst.expiry);
				}
			}

			const sortedExpiries = Array.from(expiries).sort();
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(
							{
								instrument_key: args.instrument_key,
								expiries: sortedExpiries,
								count: sortedExpiries.length,
							},
							null,
							2,
						),
					},
				],
			};
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return {
				content: [
					{ type: "text", text: JSON.stringify({ error: message }, null, 2) },
				],
				isError: true,
			};
		}
	},
);

// --------------------------------------------------------------------------
// Tool: get_options_insight
// --------------------------------------------------------------------------
server.registerTool(
	"get_options_insight",
	{
		description:
			"Master options-chain fusion tool. Fetches option chain and calculates Active OI support/resistance levels, Put-Call Ratio (PCR) bias, Max Pain, and yields structured trade recommendations.",
		inputSchema: z.object({
			instrument_key: z
				.string()
				.describe("Underlying symbol key (e.g. 'NSE_INDEX|Nifty 50')"),
			expiry_date: z.string().describe("Expiry date in YYYY-MM-DD format"),
		}),
	},
	async (args) => {
		try {
			const chainResponse = await upstoxFetch<OptionChainResponse>(
				"/v2/option/chain",
				"GET",
				{
					instrument_key: args.instrument_key,
					expiry_date: args.expiry_date,
				},
			);

			const chainEntries = chainResponse.data || [];
			if (chainEntries.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									message:
										"No option chain data available for this expiry date.",
									instrument_key: args.instrument_key,
									expiry_date: args.expiry_date,
								},
								null,
								2,
							),
						},
					],
				};
			}

			const spotPrice = chainEntries[0]?.underlying_spot_price || 0;
			const activeOI = analyzeActiveOI(chainEntries);
			const pcr = calculatePCR(chainEntries);
			const maxPain = calculateMaxPain(chainEntries);

			const recommendation = generateRecommendation(
				spotPrice,
				activeOI.resistance,
				activeOI.support,
				pcr,
				maxPain,
			);

			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(
							{
								instrument_key: args.instrument_key,
								expiry_date: args.expiry_date,
								spotPrice: Number(spotPrice.toFixed(2)),
								activeOI,
								pcr,
								maxPain,
								recommendation,
							},
							null,
							2,
						),
					},
				],
			};
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return {
				content: [
					{ type: "text", text: JSON.stringify({ error: message }, null, 2) },
				],
				isError: true,
			};
		}
	},
);

// --------------------------------------------------------------------------
// Tool: get_analyzed_option_chain
// --------------------------------------------------------------------------
server.registerTool(
	"get_analyzed_option_chain",
	{
		description:
			"Fetch options chain details (Strike, premiums, volumes, OI) filtered to a spot-centered window (e.g. Spot ± 5 strikes) to prevent context flooding.",
		inputSchema: z.object({
			instrument_key: z
				.string()
				.describe("Underlying symbol key (e.g. 'NSE_INDEX|Nifty 50')"),
			expiry_date: z.string().describe("Expiry date in YYYY-MM-DD format"),
			strike_window: z
				.number()
				.optional()
				.default(5)
				.describe("Strikes to show above and below spot price"),
		}),
	},
	async (args) => {
		try {
			const chainResponse = await upstoxFetch<OptionChainResponse>(
				"/v2/option/chain",
				"GET",
				{
					instrument_key: args.instrument_key,
					expiry_date: args.expiry_date,
				},
			);

			const chainEntries = chainResponse.data || [];
			if (chainEntries.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{ message: "No option chain data found." },
								null,
								2,
							),
						},
					],
				};
			}

			const spotPrice = chainEntries[0]?.underlying_spot_price || 0;
			const sortedEntries = [...chainEntries].sort(
				(a, b) => a.strike_price - b.strike_price,
			);

			let closestIdx = 0;
			let minDiff = Infinity;
			for (let i = 0; i < sortedEntries.length; i++) {
				const entry = sortedEntries[i];
				if (entry) {
					const diff = Math.abs(entry.strike_price - spotPrice);
					if (diff < minDiff) {
						minDiff = diff;
						closestIdx = i;
					}
				}
			}

			const startIdx = Math.max(0, closestIdx - args.strike_window);
			const endIdx = Math.min(
				sortedEntries.length - 1,
				closestIdx + args.strike_window,
			);
			const windowEntries = sortedEntries.slice(startIdx, endIdx + 1);

			const mappedEntries = windowEntries.map((e) => ({
				strike_price: e.strike_price,
				spot_distance: Number((e.strike_price - spotPrice).toFixed(2)),
				moneyness:
					e.strike_price < spotPrice
						? "ITM"
						: e.strike_price > spotPrice
							? "OTM"
							: "ATM",
				call: e.call_options
					? {
							instrument_key: e.call_options.instrument_key,
							ltp: e.call_options.market_data?.ltp || 0,
							oi: e.call_options.market_data?.oi || 0,
							volume: e.call_options.market_data?.volume || 0,
							iv: e.call_options.option_greeks?.implied_volatility || 0,
							delta: e.call_options.option_greeks?.delta || 0,
							gamma: e.call_options.option_greeks?.gamma || 0,
							theta: e.call_options.option_greeks?.theta || 0,
							vega: e.call_options.option_greeks?.vega || 0,
						}
					: null,
				put: e.put_options
					? {
							instrument_key: e.put_options.instrument_key,
							ltp: e.put_options.market_data?.ltp || 0,
							oi: e.put_options.market_data?.oi || 0,
							volume: e.put_options.market_data?.volume || 0,
							iv: e.put_options.option_greeks?.implied_volatility || 0,
							delta: e.put_options.option_greeks?.delta || 0,
							gamma: e.put_options.option_greeks?.gamma || 0,
							theta: e.put_options.option_greeks?.theta || 0,
							vega: e.put_options.option_greeks?.vega || 0,
						}
					: null,
			}));

			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(
							{
								instrument_key: args.instrument_key,
								expiry_date: args.expiry_date,
								spotPrice: Number(spotPrice.toFixed(2)),
								strikeCount: sortedEntries.length,
								filteredStrikes: mappedEntries,
							},
							null,
							2,
						),
					},
				],
			};
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return {
				content: [
					{ type: "text", text: JSON.stringify({ error: message }, null, 2) },
				],
				isError: true,
			};
		}
	},
);

// --------------------------------------------------------------------------
// Tool: get_oi_dynamics
// --------------------------------------------------------------------------
server.registerTool(
	"get_oi_dynamics",
	{
		description:
			"Retrieve strike-wise Change in Open Interest details over an interval and calculate writing vs covering dynamic trends.",
		inputSchema: z.object({
			instrument_key: z
				.string()
				.describe("Underlying instrument key (e.g. 'NSE_INDEX|Nifty 50')"),
			expiry_date: z.string().describe("Expiry date in YYYY-MM-DD format"),
			query_date: z.string().describe("Target query date in YYYY-MM-DD format"),
			interval: z
				.number()
				.int()
				.optional()
				.default(1)
				.describe("Interval count in days"),
		}),
	},
	async (args) => {
		try {
			const response = await upstoxFetch<UpstoxResponse<ChangeOIData>>(
				"/v2/market/change-oi",
				"GET",
				{
					instrument_key: args.instrument_key,
					expiry: args.expiry_date,
					date: args.query_date,
					interval: args.interval,
				},
			);
			const entries = response.data?.call_put_oi_data_list ?? [];
			const dynamics = analyzeOIDynamics(entries);
			return {
				content: [{ type: "text", text: JSON.stringify(dynamics, null, 2) }],
			};
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return {
				content: [
					{ type: "text", text: JSON.stringify({ error: message }, null, 2) },
				],
				isError: true,
			};
		}
	},
);

// --------------------------------------------------------------------------
// Tool: get_volatility_profile
// --------------------------------------------------------------------------
server.registerTool(
	"get_volatility_profile",
	{
		description:
			"Retrieve Implied Volatility (IV) profile near At-The-Money (ATM) strikes and calculate Call/Put skew indices to gauge market fear.",
		inputSchema: z.object({
			instrument_key: z
				.string()
				.describe("Underlying instrument key (e.g. 'NSE_INDEX|Nifty 50')"),
			expiry_date: z.string().describe("Expiry date in YYYY-MM-DD format"),
		}),
	},
	async (args) => {
		try {
			const chainResponse = await upstoxFetch<OptionChainResponse>(
				"/v2/option/chain",
				"GET",
				{
					instrument_key: args.instrument_key,
					expiry_date: args.expiry_date,
				},
			);
			const entries = chainResponse.data || [];
			const profile = calculateVolatilityProfile(entries);
			return {
				content: [{ type: "text", text: JSON.stringify(profile, null, 2) }],
			};
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return {
				content: [
					{ type: "text", text: JSON.stringify({ error: message }, null, 2) },
				],
				isError: true,
			};
		}
	},
);

// --------------------------------------------------------------------------
// Tool: get_technical_indicator_candles
// --------------------------------------------------------------------------
server.registerTool(
	"get_technical_indicator_candles",
	{
		description:
			"Fetch intraday or historical candle chart data for an instrument and calculate SMA (20/50/200), EMA (9/20), RSI (14), MACD (12/26/9), Bollinger Bands (20,2σ), ATR (14), and an overall trend rating (STRONG_BULLISH → STRONG_BEARISH).",
		inputSchema: z.object({
			instrument_key: z
				.string()
				.describe(
					"Instrument token key (e.g., index key 'NSE_INDEX|Nifty 50' or equity key 'NSE_EQ|INE002A01018')",
				),
			interval: z
				.enum(["1minute", "30minute", "day", "week", "month"])
				.describe("Candle duration interval"),
			to_date: z.string().describe("End date in YYYY-MM-DD format"),
			from_date: z
				.string()
				.optional()
				.describe(
					"Start date in YYYY-MM-DD format (Required and highly recommended for historical intervals)",
				),
		}),
	},
	async (args) => {
		try {
			const isIntraday = args.interval.includes("minute");
			let path = "";
			if (isIntraday) {
				path = `/v2/historical-candle/intraday/${encodeURIComponent(
					args.instrument_key,
				)}/${args.interval}`;
			} else {
				path = `/v2/historical-candle/${encodeURIComponent(
					args.instrument_key,
				)}/${args.interval}/${args.to_date}${
					args.from_date ? `/${args.from_date}` : ""
				}`;
			}

			const response = await upstoxFetch<
				UpstoxResponse<{ candles: RawCandleArray[] }>
			>(path, "GET");
			const candles = response.data?.candles || [];
			const indicators = calculateTechnicalIndicators(candles);

			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(
							{ indicators, candleCount: candles.length },
							null,
							2,
						),
					},
				],
			};
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return {
				content: [
					{ type: "text", text: JSON.stringify({ error: message }, null, 2) },
				],
				isError: true,
			};
		}
	},
);
