import { z } from "zod";
import { calculateStrategyPayoff } from "../helpers/payoff.ts";
import { server } from "../server.ts";

// --------------------------------------------------------------------------
// Tool: get_strategy_payoff
// --------------------------------------------------------------------------
server.registerTool(
	"get_strategy_payoff",
	{
		description:
			"Calculate the expiry payoff profile for a multi-leg option strategy (bull/bear spreads, iron condor, straddle, strangle, butterfly, etc.). Returns breakeven points, max profit/loss, risk-reward ratio, and a 61-point payoff curve across ±30% of the current spot price. Premiums must be provided from live market data — use get_analyzed_option_chain to fetch them.",
		inputSchema: z.object({
			spot_price: z.number().describe("Current spot price of the underlying"),
			legs: z
				.array(
					z.object({
						strike: z.number().describe("Strike price"),
						type: z.enum(["call", "put"]).describe("Option type"),
						action: z
							.enum(["buy", "sell"])
							.describe("Buy (long) or sell (short) this leg"),
						premium: z
							.number()
							.describe("Option premium paid or received per unit"),
						qty: z
							.number()
							.int()
							.optional()
							.default(1)
							.describe("Number of lots (default: 1)"),
					}),
				)
				.min(1)
				.max(6)
				.describe("Strategy legs (1–6)"),
		}),
	},
	async (args) => {
		try {
			const legs = args.legs.map((l) => ({
				strike: l.strike,
				type: l.type,
				action: l.action,
				premium: l.premium,
				qty: l.qty ?? 1,
			}));

			const result = calculateStrategyPayoff(legs, args.spot_price);

			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(
							{
								spot_price: args.spot_price,
								strategy: {
									legs,
									totalNetPremium: result.totalNetPremium,
									breakevens: result.breakevens,
									maxProfit: result.maxProfit,
									maxLoss: result.maxLoss,
									riskRewardRatio: result.riskRewardRatio,
								},
								payoffTable: result.payoffTable,
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
