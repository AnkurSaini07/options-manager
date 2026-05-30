import { createConsola } from "consola";

const consolaInstance = createConsola({
	level: 3, // Default to Info level
	reporters: [
		{
			log(logObj) {
				const time = logObj.date
					? new Date(logObj.date).toISOString()
					: new Date().toISOString();
				const levelName = logObj.type.toUpperCase();
				const message = logObj.args
					.map((arg) =>
						typeof arg === "object" ? JSON.stringify(arg) : String(arg),
					)
					.join(" ");
				const tagPart = logObj.tag ? ` [${logObj.tag}]` : "";
				const logLine = `[${time}] [${levelName}]${tagPart} ${message}`;

				// 1. Write safely to stderr so it displays in terminal without breaking MCP stdio JSON-RPC
				process.stderr.write(`${logLine}\n`);

				// 2. Append to log file using Bun's native write API
				const options = { append: true } as unknown as {
					mode?: number;
					createPath?: boolean;
				};
				Bun.write("options-manager.log", `${logLine}\n`, options).catch(
					(err) => {
						process.stderr.write(
							`[Logger Error] Failed to write to options-manager.log: ${err.message}\n`,
						);
					},
				);
			},
		},
	],
});

export function createLogger(tag: string) {
	return consolaInstance.withTag(tag);
}
