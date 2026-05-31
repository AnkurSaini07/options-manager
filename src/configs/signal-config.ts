export const SIGNAL_CONFIG = {
	pcr: {
		extremeBullish: 1.25,
		bullish: 1.0,
		bearish: 0.8,
		extremeBearish: 0.6,
	},
	proximity: {
		keyLevelPct: 0.008, // 0.8% — spot within this % of support/resistance counts
		maxPainNeutralZonePct: 0.003, // 0.3% — within this of max pain = no directional pull
	},
	rsi: {
		overbought: 78,
		oversold: 22,
	},
	iv: {
		cheap: 15, // ATM IV below this → cheap for buyers
		expensive: 22, // ATM IV above this → expensive for buyers
		sellingFavorable: 18, // ATM IV above this → favorable for sellers
		premiumTrap: 30, // ATM IV above this → buying is structurally unfavorable
	},
	liquidity: {
		minOI: 10000,
		minVolume: 300,
		fallbackMinOI: 5000, // used if no strike passes primary OI filter
	},
	delta: {
		min: 0.38,
		max: 0.55,
	},
	riskReward: {
		minimumRatio: 1.5,
	},
	greeksScenario: {
		spotShiftPct: 3, // ±3% range for scenario table
		targetShiftPct: 1.5, // +1.5% spot move = first target
		stopShiftPct: -1.0, // -1.0% spot move = stop-loss scenario
	},
	confirmations: {
		required: 2, // min out of 5 confirmation factors needed (4 original + PCR trend)
	},
	session: {
		pcrHistorySize: 6, // number of PCR readings to keep per instrument
		dedupWindowMinutes: 25, // suppress identical signal re-emission within this window
		cooldownAfterDisqualify: 20, // minutes to suppress re-evaluation after a disqualifier fires
		cooldownAfterNoMandatory: 10, // minutes to suppress when mandatory gate fails
		signalChangeThreshold: {
			// re-emit even within dedup window if setup materially changes
			convictionUpgrade: true, // MEDIUM → HIGH always re-emits
			directionFlip: true, // BULLISH → BEARISH always re-emits
			strikeDriftStrikes: 2, // re-emit if recommended strike moves by ≥ N strikes
		},
	},
	pcrTrend: {
		minReadings: 3, // need at least this many PCR readings to compute trend
		risingThreshold: 0.05, // PCR must have risen by ≥ 5% across the window to count as rising
		fallingThreshold: 0.05, // PCR must have fallen by ≥ 5% across the window to count as falling
	},
	positionSizing: {
		lotsHighConvictionCheapIV: 2,
		lotsDefault: 1,
		lotSizeNifty: 25,
		lotSizeBankNifty: 15,
	},
} as const;
