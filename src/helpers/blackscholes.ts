export interface BSResult {
	callPrice: number;
	putPrice: number;
	callDelta: number;
	putDelta: number;
	gamma: number;
	callTheta: number;
	putTheta: number;
	vega: number;
}

export interface BSScenarioPoint {
	spot: number;
	callPrice: number;
	putPrice: number;
	callDelta: number;
	putDelta: number;
	gamma: number;
	callTheta: number;
	putTheta: number;
	vega: number;
}

// Abramowitz & Stegun approximation — max error ~1.5e-7
function normCdf(x: number): number {
	const sign = x >= 0 ? 1 : -1;
	const absX = Math.abs(x);
	const t = 1 / (1 + 0.3275911 * absX);
	const poly =
		(((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) *
			t +
		0.254829592;
	const erfApprox = 1 - poly * t * Math.exp(-absX * absX);
	return 0.5 * (1 + sign * erfApprox);
}

function normPdf(x: number): number {
	return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/**
 * Black-Scholes pricing for European options.
 * @param spot          Current underlying price
 * @param strike        Option strike price
 * @param tte           Time to expiry in years (e.g. 0.082 for 30 days)
 * @param annualIV      Annual implied volatility as decimal (e.g. 0.15 for 15%)
 * @param riskFreeRate  Annual risk-free rate as decimal (default 0.065 for India ~6.5%)
 */
export function blackScholes(
	spot: number,
	strike: number,
	tte: number,
	annualIV: number,
	riskFreeRate = 0.065,
): BSResult | null {
	if (tte <= 0 || annualIV <= 0 || spot <= 0 || strike <= 0) return null;

	const sqrtT = Math.sqrt(tte);
	const d1 =
		(Math.log(spot / strike) +
			(riskFreeRate + 0.5 * annualIV * annualIV) * tte) /
		(annualIV * sqrtT);
	const d2 = d1 - annualIV * sqrtT;

	const Nd1 = normCdf(d1);
	const Nd2 = normCdf(d2);
	const NnD1 = normCdf(-d1);
	const NnD2 = normCdf(-d2);
	const nd1 = normPdf(d1);
	const df = Math.exp(-riskFreeRate * tte);

	const callPrice = spot * Nd1 - strike * df * Nd2;
	const putPrice = strike * df * NnD2 - spot * NnD1;

	// Theta is expressed per calendar day
	const sharedTheta = -(spot * nd1 * annualIV) / (2 * sqrtT);
	const callTheta = (sharedTheta - riskFreeRate * strike * df * Nd2) / 365;
	const putTheta = (sharedTheta + riskFreeRate * strike * df * NnD2) / 365;

	// Vega expressed per 1% change in IV
	const vega = (spot * nd1 * sqrtT) / 100;

	return {
		callPrice: Number(callPrice.toFixed(2)),
		putPrice: Number(putPrice.toFixed(2)),
		callDelta: Number(Nd1.toFixed(4)),
		putDelta: Number((Nd1 - 1).toFixed(4)),
		gamma: Number((nd1 / (spot * annualIV * sqrtT)).toFixed(8)),
		callTheta: Number(callTheta.toFixed(4)),
		putTheta: Number(putTheta.toFixed(4)),
		vega: Number(vega.toFixed(4)),
	};
}

/**
 * Days (fractional) from now to expiry, using 15:30 IST as the expiry cutoff.
 * Returns at least a minimum of 1/1440 day (~1 minute) so BS doesn't receive tte=0.
 */
export function daysToExpiry(expiryDate: string): number {
	// Expiry settles at 15:30 IST = UTC+05:30 → 10:00 UTC
	const [year, month, day] = expiryDate.split("-").map(Number);
	const expiryUtc = Date.UTC(year!, month! - 1, day!, 10, 0, 0); // 10:00 UTC = 15:30 IST
	const nowMs = Date.now();
	const diffMs = expiryUtc - nowMs;
	const MIN_DAYS = 1 / 1440; // 1 minute floor to keep TTE positive
	return Math.max(MIN_DAYS, diffMs / (1000 * 60 * 60 * 24));
}

/**
 * Invert Black-Scholes to find implied volatility from a market price.
 * Uses Newton-Raphson iteration. Returns IV as a percentage (e.g. 15.0 for 15%),
 * matching the format Upstox returns for option_greeks.implied_volatility.
 * Returns null when the inversion does not converge (deep ITM/OTM, near-expiry).
 */
export function calculateImpliedVolatility(
	marketPrice: number,
	spot: number,
	strike: number,
	tte: number,
	isCall: boolean,
	riskFreeRate = 0.065,
): number | null {
	if (tte <= 0 || marketPrice <= 0 || spot <= 0 || strike <= 0) return null;

	// Brenner-Subrahmanyam approximation for initial guess
	const guess = Math.sqrt((2 * Math.PI) / tte) * (marketPrice / spot);
	let iv = Math.max(0.05, Math.min(guess, 3.0));

	const MAX_ITER = 100;
	const TOLERANCE = 1e-5;

	for (let i = 0; i < MAX_ITER; i++) {
		const bs = blackScholes(spot, strike, tte, iv, riskFreeRate);
		if (!bs) return null;

		const price = isCall ? bs.callPrice : bs.putPrice;
		const diff = price - marketPrice;
		if (Math.abs(diff) < TOLERANCE) return Number((iv * 100).toFixed(4));

		// bs.vega is price change per 1% IV — multiply by 100 for per-unit-decimal vega
		const vegaPerUnit = bs.vega * 100;
		if (vegaPerUnit < 1e-10) return null;

		iv = iv - diff / vegaPerUnit;
		if (iv <= 0 || iv > 5.0) return null;
	}

	return null;
}

/**
 * Build a scenario table of BS prices and Greeks across a spot range.
 * @param strike      Strike price to evaluate
 * @param expiryDate  Expiry date string YYYY-MM-DD
 * @param annualIV    Annual IV as decimal (e.g. 0.15)
 * @param spotMin     Lower bound of spot range
 * @param spotMax     Upper bound of spot range
 * @param steps       Number of equally-spaced points (default 20)
 */
export function buildGreeksScenario(
	strike: number,
	expiryDate: string,
	annualIV: number,
	spotMin: number,
	spotMax: number,
	steps = 20,
): BSScenarioPoint[] {
	const tte = daysToExpiry(expiryDate) / 365;
	const stepSize = (spotMax - spotMin) / steps;
	const results: BSScenarioPoint[] = [];

	for (let i = 0; i <= steps; i++) {
		const spot = Number((spotMin + i * stepSize).toFixed(2));
		const bs = blackScholes(spot, strike, tte, annualIV);
		if (bs) {
			results.push({
				spot,
				callPrice: bs.callPrice,
				putPrice: bs.putPrice,
				callDelta: bs.callDelta,
				putDelta: bs.putDelta,
				gamma: bs.gamma,
				callTheta: bs.callTheta,
				putTheta: bs.putTheta,
				vega: bs.vega,
			});
		}
	}

	return results;
}
