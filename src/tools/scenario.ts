import { z } from "zod";
import { upstoxFetch } from "../clients/upstox.ts";
import type { OptionChainResponse } from "../helpers/analysis.ts";
import { buildGreeksScenario, daysToExpiry } from "../helpers/blackscholes.ts";
import { server } from "../server.ts";

// --------------------------------------------------------------------------
// Tool: get_greeks_scenario
// --------------------------------------------------------------------------
server.registerTool(
	"get_greeks_scenario",
	{
		description:
			"Run Black-Scholes scenario analysis for a specific option strike across a spot price range. Simulates how the option premium, delta, gamma, theta, and vega evolve as the underlying moves. Useful for risk visualisation and position sizing before entering a trade.",
		inputSchema: z.object({
			instrument_key: z
				.string()
				.describe("Underlying instrument key (e.g. 'NSE_INDEX|Nifty 50')"),
			expiry_date: z.string().describe("Expiry date in YYYY-MM-DD format"),
			strike: z.number().describe("Strike price to analyse"),
			option_type: z.enum(["call", "put"]).describe("Option type to simulate"),
			spot_shift_pct: z
				.number()
				.optional()
				.default(5)
				.describe(
					"Percentage range to simulate on either side of current spot (e.g. 5 = ±5%). Default: 5",
				),
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
			if (entries.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{ message: "No option chain data found for this expiry." },
								null,
								2,
							),
						},
					],
				};
			}

			const spotPrice = entries[0]?.underlying_spot_price || 0;

			// Prefer IV from the requested strike; fall back to ATM average IV
			const targetEntry = entries.find((e) => e.strike_price === args.strike);
			const rawIV =
				args.option_type === "call"
					? targetEntry?.call_options?.option_greeks?.implied_volatility
					: targetEntry?.put_options?.option_greeks?.implied_volatility;

			let ivPct = rawIV || 0;
			if (!ivPct) {
				const sorted = [...entries].sort(
					(a, b) => a.strike_price - b.strike_price,
				);
				const atm = sorted.reduce((prev, cur) =>
					Math.abs(cur.strike_price - spotPrice) <
					Math.abs(prev.strike_price - spotPrice)
						? cur
						: prev,
				);
				const cIV = atm?.call_options?.option_greeks?.implied_volatility || 0;
				const pIV = atm?.put_options?.option_greeks?.implied_volatility || 0;
				ivPct = (cIV + pIV) / 2;
			}

			if (!ivPct) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									message:
										"Implied volatility unavailable for this expiry. The chain may have stale or zero-IV data.",
								},
								null,
								2,
							),
						},
					],
				};
			}

			// Upstox IV is in percentage form (e.g. 14.5 → 0.145)
			const annualIV = ivPct / 100;
			const dte = daysToExpiry(args.expiry_date);
			const shift = args.spot_shift_pct / 100;

			const scenario = buildGreeksScenario(
				args.strike,
				args.expiry_date,
				annualIV,
				spotPrice * (1 - shift),
				spotPrice * (1 + shift),
				20,
			);

			// Scenario point closest to current spot for the summary
			const current = scenario.reduce((best, p) =>
				Math.abs(p.spot - spotPrice) < Math.abs(best.spot - spotPrice)
					? p
					: best,
			);

			const isCall = args.option_type === "call";
			const scenarioTable = scenario.map((s) => ({
				spot: s.spot,
				price: isCall ? s.callPrice : s.putPrice,
				delta: isCall ? s.callDelta : s.putDelta,
				gamma: s.gamma,
				theta: isCall ? s.callTheta : s.putTheta,
				vega: s.vega,
			}));

			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(
							{
								instrument_key: args.instrument_key,
								expiry_date: args.expiry_date,
								strike: args.strike,
								option_type: args.option_type,
								currentSpot: Number(spotPrice.toFixed(2)),
								daysToExpiry: dte,
								ivUsedPct: Number(ivPct.toFixed(2)),
								currentGreeks: {
									price: isCall ? current.callPrice : current.putPrice,
									delta: isCall ? current.callDelta : current.putDelta,
									gamma: current.gamma,
									theta: isCall ? current.callTheta : current.putTheta,
									vega: current.vega,
								},
								scenarioTable,
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
