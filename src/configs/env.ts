/**
 * Application environment configuration
 */

import { createLogger } from "../helpers/logger.ts";

const logger = createLogger("env");

export const BASE_URL = "https://api-v2.upstox.com";
export const UPSTOX_TOKEN = process.env.UPSTOX_TOKEN || "";

if (!UPSTOX_TOKEN) {
	logger.warn("[Warning] UPSTOX_API_TOKEN is not defined in the environment.");
}
