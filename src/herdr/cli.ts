/**
 * @file cli.ts — thin wrapper around the `herdr` CLI.
 *
 * Every control command goes through the CLI (not the raw socket) as herdr's
 * own agent skill recommends: the binary handles socket discovery via
 * HERDR_SOCKET_PATH and stays compatible across protocol revisions. Server
 * errors come back as JSON with an error code on either stream; both are
 * parsed here so callers only ever see a CliResult.
 */

import { type ChildProcess, execFile, spawn } from "node:child_process";

export interface CliResult {
	ok: boolean;
	code: number | null;
	stdout: string;
	stderr: string;
	/** Parsed JSON payload when the command produced one. */
	json?: unknown;
	/** Herdr error code such as "timeout" or "not_found", when the command failed. */
	errorCode?: string | undefined;
	errorMessage?: string | undefined;
}

/** A long-running blocking wait (`herdr wait …`) that can be cancelled. */
export interface Waiter {
	promise: Promise<CliResult>;
	kill(): void;
}

export interface HerdrCli {
	exec(args: string[], opts?: { timeoutMs?: number }): Promise<CliResult>;
	spawnWaiter(args: string[]): Waiter;
}

function parsePayload(stdout: string, stderr: string): Pick<CliResult, "json" | "errorCode" | "errorMessage"> {
	for (const raw of [stdout, stderr]) {
		const text = raw.trim();
		if (!text) continue;
		// Waits stream one JSON object per line; the last line carries the outcome.
		const lines = text.split("\n");
		const candidate = lines[lines.length - 1] ?? text;
		for (const source of [candidate, text]) {
			try {
				const json = JSON.parse(source) as { error?: { code?: string; message?: string } };
				return {
					json,
					errorCode: json.error?.code,
					errorMessage: json.error?.message,
				};
			} catch {
				// Not JSON (e.g. `pane read --format text`); fall through.
			}
		}
	}
	return {};
}

const EXEC_TIMEOUT_MS = 15_000;
const MAX_BUFFER = 8 * 1024 * 1024;

export function createHerdrCli(binary = "herdr"): HerdrCli {
	return {
		exec(args, opts) {
			return new Promise<CliResult>((resolvePromise) => {
				execFile(
					binary,
					args,
					{ timeout: opts?.timeoutMs ?? EXEC_TIMEOUT_MS, maxBuffer: MAX_BUFFER },
					(error, stdout, stderr) => {
						const code = error ? ((error as NodeJS.ErrnoException & { code?: number | string }).code ?? 1) : 0;
						const payload = parsePayload(stdout, stderr);
						resolvePromise({
							ok: !error && payload.errorCode === undefined,
							code: typeof code === "number" ? code : null,
							stdout,
							stderr,
							...payload,
							...(error && !payload.errorMessage ? { errorMessage: error.message } : {}),
						});
					},
				);
			});
		},

		spawnWaiter(args) {
			let child: ChildProcess | undefined;
			let killed = false;
			const promise = new Promise<CliResult>((resolvePromise) => {
				child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
				let stdout = "";
				let stderr = "";
				child.stdout?.setEncoding("utf8");
				child.stderr?.setEncoding("utf8");
				child.stdout?.on("data", (chunk: string) => {
					stdout += chunk;
				});
				child.stderr?.on("data", (chunk: string) => {
					stderr += chunk;
				});
				const settle = (code: number | null): void => {
					const payload = parsePayload(stdout, stderr);
					resolvePromise({
						ok: code === 0 && payload.errorCode === undefined && !killed,
						code,
						stdout,
						stderr,
						...payload,
						...(killed ? { errorCode: payload.errorCode ?? "cancelled" } : {}),
					});
				};
				child.on("exit", (code) => settle(code));
				child.on("error", (error) => {
					stderr += `\n${error.message}`;
					settle(127);
				});
			});
			return {
				promise,
				kill() {
					killed = true;
					try {
						child?.kill("SIGTERM");
					} catch {
						// Already gone.
					}
				},
			};
		},
	};
}

/** Depth-first search for a string property in a parsed CLI response. */
export function findString(value: unknown, key: string): string | undefined {
	if (value === null || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	if (typeof record[key] === "string") return record[key] as string;
	for (const child of Object.values(record)) {
		const found = findString(child, key);
		if (found !== undefined) return found;
	}
	return undefined;
}
