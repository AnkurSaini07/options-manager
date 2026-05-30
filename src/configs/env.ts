import { createLogger } from "../helpers/logger.ts";

const logger = createLogger("env-config");

export const BASE_URL = "https://api-v2.upstox.com";

let resolvedToken = process.env.UPSTOX_TOKEN || "";

// Natively attempt to resolve from adjacent workspace via Bun.file if not defined in env
if (!resolvedToken) {
	const adjacentEnvPath = "/Users/ankurs/agy-workspace/upstox/.env";
	try {
		const envFile = Bun.file(adjacentEnvPath);
		if (await envFile.exists()) {
			const content = await envFile.text();
			const match = content.match(/UPSTOX_TOKEN\s*=\s*(.+)/);
			if (match?.[1]) {
				resolvedToken = match[1].trim().replace(/^['"]|['"]$/g, ""); // strip quotes if any
				logger.success(
					"Successfully loaded token from adjacent .env natively.",
				);
			}
		}
	} catch (error) {
		logger.error(
			`Error natively reading adjacent env at ${adjacentEnvPath}:`,
			error,
		);
	}
}

export const UPSTOX_TOKEN = resolvedToken;
