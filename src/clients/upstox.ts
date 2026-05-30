import { BASE_URL, UPSTOX_TOKEN } from "../configs/env.ts";

/**
 * Standard generic shape of a successful/failed Upstox API response
 */
export interface UpstoxResponse<T> {
	status: string;
	data: T;
	errors?: Array<{
		errorCode?: string;
		message?: string;
		propertyPath?: string;
	}>;
}

/**
 * Custom error class for Upstox API responses
 */
export class UpstoxApiError extends Error {
	status: number;
	data: unknown;

	constructor(message: string, status: number, data: unknown) {
		super(message);
		this.name = "UpstoxApiError";
		this.status = status;
		this.data = data;
	}
}

/**
 * Execute an authenticated request to the Upstox API.
 */
export async function upstoxFetch<T = unknown>(
	path: string,
	method: "GET" | "POST" | "PUT" | "DELETE",
	queryParams: Record<
		string,
		string | number | boolean | undefined | null
	> = {},
	bodyParams: unknown = null,
): Promise<T> {
	if (!UPSTOX_TOKEN) {
		throw new Error(
			"UPSTOX_TOKEN is not defined. Please set it in environment variables or your adjacent workspace .env file.",
		);
	}

	// Setup API version dynamically (3.0 for v3 endpoints, 2.0 for v2 endpoints)
	const isV3 = path.startsWith("/v3/");
	const apiVersion = isV3 ? "3.0" : "2.0";

	// Build the URL with query parameters
	const urlObj = new URL(`${BASE_URL}${path}`);
	for (const [key, value] of Object.entries(queryParams)) {
		if (value !== undefined && value !== null) {
			urlObj.searchParams.append(key, String(value));
		}
	}

	const headers: Record<string, string> = {
		Authorization: `Bearer ${UPSTOX_TOKEN}`,
		"Api-Version": apiVersion,
		Accept: "application/json",
	};

	const options: RequestInit = {
		method,
		headers,
	};

	if (bodyParams) {
		headers["Content-Type"] = "application/json";
		options.body = JSON.stringify(bodyParams);
	}

	try {
		const response = await fetch(urlObj.toString(), options);
		const text = await response.text();

		let json: unknown;
		try {
			json = JSON.parse(text);
		} catch {
			if (!response.ok) {
				throw new UpstoxApiError(
					`HTTP error! status: ${response.status}`,
					response.status,
					text,
				);
			}
			return text as unknown as T;
		}

		if (!response.ok) {
			const parsed = json as
				| { errors?: Array<{ message?: string }> }
				| null
				| undefined;
			const errorMsg =
				parsed?.errors?.[0]?.message ||
				`API error with status ${response.status}`;
			throw new UpstoxApiError(errorMsg, response.status, json);
		}

		return json as T;
	} catch (error) {
		if (error instanceof UpstoxApiError) {
			throw error;
		}
		const errorMsg = error instanceof Error ? error.message : String(error);
		throw new Error(`Upstox Network Exception: ${errorMsg}`);
	}
}
