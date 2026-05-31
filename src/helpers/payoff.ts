export interface StrategyLeg {
	strike: number;
	type: "call" | "put";
	action: "buy" | "sell";
	qty: number;
	premium: number;
}

export interface PayoffPoint {
	spot: number;
	payoff: number;
}

export interface PayoffResult {
	totalNetPremium: number;
	breakevens: number[];
	maxProfit: number | "UNLIMITED";
	maxLoss: number | "UNLIMITED";
	riskRewardRatio: number | null;
	payoffTable: PayoffPoint[];
}

function legPayoffAtExpiry(leg: StrategyLeg, spot: number): number {
	const intrinsic =
		leg.type === "call"
			? Math.max(spot - leg.strike, 0)
			: Math.max(leg.strike - spot, 0);
	const pnl =
		leg.action === "buy" ? intrinsic - leg.premium : leg.premium - intrinsic;
	return pnl * leg.qty;
}

// Net long call qty: positive → unlimited upside profit; negative → unlimited upside loss
function netCallQty(legs: StrategyLeg[]): number {
	return legs
		.filter((l) => l.type === "call")
		.reduce((sum, l) => sum + (l.action === "buy" ? l.qty : -l.qty), 0);
}

/**
 * Calculate strategy payoff profile at expiry across ±30% of current spot.
 */
export function calculateStrategyPayoff(
	legs: StrategyLeg[],
	currentSpot: number,
): PayoffResult {
	const spotMin = currentSpot * 0.7;
	const spotMax = currentSpot * 1.3;
	const steps = 60;
	const stepSize = (spotMax - spotMin) / steps;

	const payoffTable: PayoffPoint[] = [];
	for (let i = 0; i <= steps; i++) {
		const spot = Number((spotMin + i * stepSize).toFixed(2));
		const payoff = Number(
			legs
				.reduce((sum, leg) => sum + legPayoffAtExpiry(leg, spot), 0)
				.toFixed(2),
		);
		payoffTable.push({ spot, payoff });
	}

	// Linear-interpolation breakevens at sign changes
	const breakevens: number[] = [];
	for (let i = 0; i < payoffTable.length - 1; i++) {
		const a = payoffTable[i];
		const b = payoffTable[i + 1];
		if (!a || !b) continue;
		if (a.payoff === 0) {
			breakevens.push(a.spot);
		} else if (a.payoff * b.payoff < 0) {
			const be =
				a.spot + (b.spot - a.spot) * (-a.payoff / (b.payoff - a.payoff));
			breakevens.push(Number(be.toFixed(2)));
		}
	}

	const payoffs = payoffTable.map((p) => p.payoff);
	const maxInRange = Math.max(...payoffs);
	const minInRange = Math.min(...payoffs);

	const net = netCallQty(legs);
	const maxProfit: number | "UNLIMITED" = net > 0 ? "UNLIMITED" : maxInRange;
	const maxLoss: number | "UNLIMITED" = net < 0 ? "UNLIMITED" : minInRange;

	let riskRewardRatio: number | null = null;
	if (
		typeof maxProfit === "number" &&
		typeof maxLoss === "number" &&
		maxLoss < 0 &&
		maxProfit > 0
	) {
		riskRewardRatio = Number((maxProfit / Math.abs(maxLoss)).toFixed(2));
	}

	const totalNetPremium = Number(
		legs
			.reduce(
				(sum, l) => sum + (l.action === "buy" ? -l.premium : l.premium) * l.qty,
				0,
			)
			.toFixed(2),
	);

	return {
		totalNetPremium,
		breakevens,
		maxProfit,
		maxLoss,
		riskRewardRatio,
		payoffTable,
	};
}
