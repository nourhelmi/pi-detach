export interface BbContext {
	threadId: string;
	projectId: string;
	environmentId: string;
	serverUrl: string;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

export function detectBbContext(env: NodeJS.ProcessEnv = process.env): BbContext | undefined {
	const values = [env.BB_THREAD_ID, env.BB_PROJECT_ID, env.BB_ENVIRONMENT_ID, env.BB_SERVER_URL];
	const present = values.filter((value) => Boolean(value?.trim())).length;
	if (present === 0) return undefined;
	if (present !== values.length) throw new Error("partial BB context is forbidden");
	if (env.HERDR_ENV === "1" || env.HERDR_PANE_ID || env.HERDR_SOCKET_PATH) {
		throw new Error("BB and Herdr contexts are mutually exclusive");
	}
	const threadId = values[0];
	const projectId = values[1];
	const environmentId = values[2];
	const server = values[3];
	if (!threadId || !projectId || !environmentId || !server) throw new Error("partial BB context is forbidden");
	for (const [name, value] of [["BB_THREAD_ID", threadId], ["BB_PROJECT_ID", projectId], ["BB_ENVIRONMENT_ID", environmentId]] as const) {
		if (!ID.test(value)) throw new Error(`${name} has invalid syntax`);
	}
	const url = new URL(server);
	if (url.protocol !== "http:" || !["127.0.0.1", "::1", "localhost"].includes(url.hostname) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
		throw new Error("BB_SERVER_URL must be a credential-free loopback http origin");
	}
	return { threadId, projectId, environmentId, serverUrl: url.origin };
}
