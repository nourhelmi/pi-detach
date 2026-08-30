import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

const SAFE_ARGUMENT = /^[a-zA-Z0-9_./:@,=+-]+$/;
const SAFE_SKILL = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const NonEmptyString = Type.String({ minLength: 1 });
const ThinkingLevelSchema = Type.Union([
	Type.Literal("off"),
	Type.Literal("minimal"),
	Type.Literal("low"),
	Type.Literal("medium"),
	Type.Literal("high"),
	Type.Literal("xhigh"),
	Type.Literal("max"),
]);
const AgentProfileSchema = Type.Object(
	{
		description: Type.Optional(NonEmptyString),
		agent: Type.Optional(NonEmptyString),
		skill: Type.Optional(Type.String({ pattern: SAFE_SKILL.source })),
		skillPath: Type.Optional(NonEmptyString),
		tools: Type.Optional(Type.Array(NonEmptyString)),
		excludeTools: Type.Optional(Type.Array(NonEmptyString)),
		cliArgs: Type.Optional(Type.Array(NonEmptyString)),
		// Deprecated policy fields are intentionally accepted without validation
		// and discarded after parsing so they cannot block a transport launch.
		allowedModels: Type.Optional(Type.Unknown()),
		allowedThinkingByModel: Type.Optional(Type.Unknown()),
		turnCapFlag: Type.Optional(Type.String({ pattern: "^--[a-z0-9][a-z0-9-]*$" })),
		maxTurns: Type.Optional(Type.Integer({ minimum: 1 })),
		requireAnchor: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
);
const AgentProfilesConfigSchema = Type.Object(
	{
		defaultAgent: Type.Optional(NonEmptyString),
		// Deprecated intelligence metadata, retained only for config migration.
		models: Type.Optional(Type.Unknown()),
		profiles: Type.Optional(Type.Record(Type.String(), AgentProfileSchema)),
	},
	{ additionalProperties: false },
);

export type ThinkingLevel = Static<typeof ThinkingLevelSchema>;
export type WorkerHarness = "pi" | "native";

export interface ModelEntry {
	character?: string;
	thinking?: ThinkingLevel[];
	defaultThinking?: ThinkingLevel;
}

export interface AgentProfile {
	description?: string;
	agent?: string;
	skill?: string;
	skillPath?: string;
	tools?: string[];
	excludeTools?: string[];
	cliArgs?: string[];
	/** @deprecated Accepted for config compatibility but ignored at launch. */
	allowedModels?: string[];
	/** @deprecated Accepted for config compatibility but ignored at launch. */
	allowedThinkingByModel?: Record<string, ThinkingLevel[]>;
	turnCapFlag?: string;
	maxTurns?: number;
	requireAnchor?: boolean;
}

interface AgentProfilesConfig {
	defaultAgent: string;
	profiles: Record<string, AgentProfile>;
	baseDir: string;
}

export interface ResolveAgentLaunchOptions {
	agent?: string;
	role?: string;
	model?: string;
	thinking?: ThinkingLevel;
	maxTurns?: number;
	harness?: WorkerHarness;
	prompt: string;
	label: string;
	anchor?: string;
	acceptance?: string[];
	requiredSkills?: string[];
	resultPath?: string;
	configPath?: string;
}

export interface ResolvedAgentLaunch {
	command: string;
	prompt: string;
	role?: string;
	runtime: string;
	provider?: string;
	model?: string;
	thinking?: string;
	maxTurns?: number;
	resultPath?: string;
}

interface LaunchIdentity {
	provider?: string;
	model?: string;
	thinking?: ThinkingLevel;
	maxTurns?: number;
}

async function readConfig(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

function parseConfig(contents: string, path: string): AgentProfilesConfig {
	let json: unknown;
	try {
		json = JSON.parse(contents);
	} catch {
		throw new Error(`Could not parse bg_agent profile config ${path}`);
	}
	let parsed: Static<typeof AgentProfilesConfigSchema>;
	try {
		parsed = Value.Parse(AgentProfilesConfigSchema, json);
	} catch {
		throw new Error(`Invalid bg_agent profile config ${path}`);
	}
	const profiles = (parsed.profiles ?? {}) as Record<string, AgentProfile>;
	for (const name of Object.keys(profiles)) {
		if (!SAFE_SKILL.test(name)) throw new Error(`profile name ${name} is not a valid role slug`);
	}
	return { defaultAgent: parsed.defaultAgent ?? "pi", profiles, baseDir: dirname(path) };
}

async function loadConfig(path: string): Promise<AgentProfilesConfig> {
	const contents = await readConfig(path);
	return contents === undefined
		? { defaultAgent: "pi", profiles: {}, baseDir: dirname(path) }
		: parseConfig(contents, path);
}

function defaultConfigPath(): string {
	return (
		process.env.PI_DETACH_AGENT_PROFILES ??
		join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "bg-agent-profiles.json")
	);
}

function commandArgument(value: string, field: string): string {
	if (!SAFE_ARGUMENT.test(value)) {
		throw new Error(`${field} contains characters that bg_agent cannot pass safely`);
	}
	return value;
}

function sessionName(label: string): string {
	return (
		label
			.toLowerCase()
			.replace(/[^a-z0-9_-]+/g, "-")
			.replace(/^[^a-z]+/, "")
			.replace(/-+$/g, "")
			.slice(0, 48) || "pi-worker"
	);
}

function splitModel(value: string): { provider: string; model: string } {
	const separator = value.indexOf("/");
	if (separator < 1 || separator === value.length - 1) {
		throw new Error(`bg_agent model must be "provider/model-id", got "${value}"`);
	}
	return { provider: value.slice(0, separator), model: value.slice(separator + 1) };
}

/** Resolve optional runtime identity and the profile's transport turn cap. */
function selectIdentity(
	options: ResolveAgentLaunchOptions,
	profile?: AgentProfile,
): LaunchIdentity {
	const identity: LaunchIdentity = {};
	if (options.model) {
		const { provider, model } = splitModel(options.model);
		identity.provider = provider;
		identity.model = model;
		if (options.thinking) identity.thinking = options.thinking;
	}
	const maxTurns = options.maxTurns ?? profile?.maxTurns;
	if (maxTurns) identity.maxTurns = maxTurns;
	return identity;
}

function runtimeKind(executable: string): string {
	return executable.split("/").pop() ?? executable;
}

function buildAgentCommand(
	profile: AgentProfile,
	identity: LaunchIdentity,
	defaultAgent: string,
	label: string,
): string {
	const executable = profile.agent ?? defaultAgent;
	const runtime = runtimeKind(executable);
	const args = [commandArgument(executable, "agent")];
	if (runtime === "pi") {
		if (identity.provider) args.push("--provider", commandArgument(identity.provider, "provider"));
		if (identity.model) args.push("--model", commandArgument(identity.model, "model"));
		if (identity.thinking) args.push("--thinking", identity.thinking);
		args.push("--name", sessionName(label));
		if (profile.tools?.length) args.push("--tools", commandArgument(profile.tools.join(","), "tools"));
		if (profile.excludeTools?.length) {
			args.push("--exclude-tools", commandArgument(profile.excludeTools.join(","), "excludeTools"));
		}
	} else {
		if (profile.tools?.length || profile.excludeTools?.length) {
			throw new Error(`bg_agent role tools and excludeTools only configure Pi, not ${runtime}`);
		}
		if (identity.model) args.push("--model", commandArgument(identity.model, "model"));
		if (identity.thinking && runtime === "codex") {
			args.push("-c", `model_reasoning_effort=${identity.thinking}`);
		} else if (identity.thinking && runtime === "claude") {
			args.push("--effort", identity.thinking);
		} else if (identity.thinking) {
			throw new Error(`bg_agent does not know the native thinking flag for ${runtime}`);
		}
	}
	for (const argument of profile.cliArgs ?? []) args.push(commandArgument(argument, "cliArgs"));
	if (profile.turnCapFlag && identity.maxTurns) {
		args.push(profile.turnCapFlag, String(identity.maxTurns));
	}
	return args.join(" ");
}
function nativeRuntime(provider: string | undefined): "codex" | "claude" {
	if (provider === "openai-codex" || provider === "openai") return "codex";
	if (provider === "claude-bridge" || provider === "anthropic") return "claude";
	throw new Error(
		`bg_agent native harness requires an OpenAI Codex or Anthropic model, got ${provider ?? "no provider"}`,
	);
}

function buildNativeCommand(identity: LaunchIdentity): { command: string; runtime: "codex" | "claude" } {
	if (!identity.model) throw new Error("bg_agent native harness requires an explicit model");
	const runtime = nativeRuntime(identity.provider);
	const args = [runtime, "--model", commandArgument(identity.model, "model")];
	if (runtime === "codex") {
		if (identity.thinking) args.push("-c", `model_reasoning_effort=${identity.thinking}`);
		args.push("-c", "approval_policy=never", "--sandbox", "danger-full-access");
	} else {
		if (identity.thinking) args.push("--effort", identity.thinking);
		args.push("--dangerously-skip-permissions");
	}
	return { command: args.join(" "), runtime };
}

function nativeResultPath(value: string | undefined): string {
	if (value?.trim()) return resolve(value);
	const root = process.env.ADVISOR_STATE_ROOT ?? join(tmpdir(), "pi-detach");
	return join(root, "runs", "native", randomUUID(), "result.md");
}

function rolePrompt(
	options: ResolveAgentLaunchOptions,
	role: string,
	profile: AgentProfile,
	config: AgentProfilesConfig,
	maxTurns: number | undefined,
	resultPath: string | undefined,
): string {
	const criteria = [...(options.acceptance ?? []), ...(options.anchor ? [options.anchor] : [])]
		.map((criterion) => criterion.trim())
		.filter(Boolean);
	if (profile.requireAnchor && criteria.length === 0) {
		throw new Error(
			`bg_agent role ${role} requires at least one acceptance criterion (acceptance or anchor)`,
		);
	}
	const skills = options.requiredSkills ?? [];
	for (const skill of skills) {
		if (!SAFE_SKILL.test(skill)) throw new Error(`required skill ${skill} is not a valid skill name`);
	}
	const packet = [
		`ROLE: ${role}`,
		"",
		"TASK:",
		options.prompt.trim(),
		"",
		"ACCEPTANCE CRITERIA:",
		"Falsifiable claims this work must survive. Verify each yourself before reporting done; map your result Claims one-to-one to these criteria with direct evidence.",
		...(criteria.length
			? criteria.map((criterion, index) => `${index + 1}. ${criterion}`)
			: ["1. Return the requested bounded result with direct evidence."]),
		"",
		"REQUIRED SKILLS:",
		"Load and follow each listed skill before starting.",
		`Named skills are installed under ${join(config.baseDir, "skills")}. Resolve a named skill to <skill-root>/<name>/SKILL.md when present; otherwise use the harness's native skill discovery.`,
		skills.length ? skills.map((skill) => `- ${skill}`).join("\n") : "- None beyond the role contract.",
	];
	if (maxTurns) packet.push("", `TURN CAP: ${maxTurns}`);
	if (resultPath) {
		packet.push(
			"",
			"RESULT ARTIFACT:",
			`Create the parent directory and write the durable bounded result to ${resultPath}.`,
			"Include Status, Claims, Evidence, Files, Decisions, and Remaining Risk. Return this path in the final response.",
		);
	}
	if (profile.skill) {
		const location = profile.skillPath
			? ` at ${resolve(config.baseDir, profile.skillPath)}`
			: "";
		packet.unshift(`Load and follow the ${profile.skill} skill${location} before starting.`, "");
	}
	return packet.join("\n");
}

function availableRoles(config: AgentProfilesConfig): string {
	return (
		Object.keys(config.profiles)
			.toSorted((left, right) => left.localeCompare(right))
			.join(", ") || "none"
	);
}

function identityDetails(identity: LaunchIdentity): Partial<ResolvedAgentLaunch> {
	return {
		...(identity.provider ? { provider: identity.provider } : {}),
		...(identity.model ? { model: identity.model } : {}),
		...(identity.thinking ? { thinking: identity.thinking } : {}),
		...(identity.maxTurns ? { maxTurns: identity.maxTurns } : {}),
	};
}

function resolveProfileLaunch(
	options: ResolveAgentLaunchOptions,
	config: AgentProfilesConfig,
): ResolvedAgentLaunch {
	const role = options.role ?? "";
	const profile = config.profiles[role];
	if (!profile) {
		throw new Error(`Unknown bg_agent role ${role}. Available roles: ${availableRoles(config)}`);
	}
	const identity = selectIdentity(options, profile);
	if (options.harness === "native" && (profile.tools?.length || profile.excludeTools?.length)) {
		throw new Error(`bg_agent role ${role} uses Pi-only tool filtering that cannot be applied to a native harness`);
	}
	const native = options.harness === "native" ? buildNativeCommand(identity) : undefined;
	const resultPath = native ? nativeResultPath(options.resultPath) : undefined;
	return {
		command: native?.command ?? buildAgentCommand(profile, identity, config.defaultAgent, options.label),
		prompt: rolePrompt(options, role, profile, config, identity.maxTurns, resultPath),
		role,
		runtime: native?.runtime ?? (profile.agent ?? config.defaultAgent).split(/\s+/)[0] ?? "pi",
		...(resultPath ? { resultPath } : {}),
		...identityDetails(identity),
	};
}

/** Resolve a visible helper launch from an explicit command or a configured role profile. */
export async function resolveAgentLaunch(
	options: ResolveAgentLaunchOptions,
): Promise<ResolvedAgentLaunch> {
	if (options.agent && options.role) throw new Error("Choose either agent or role, not both");
	if (options.agent && options.harness) throw new Error("harness cannot be combined with an explicit agent command");
	if (options.agent && (options.model || options.thinking || options.maxTurns !== undefined)) {
		throw new Error("model, thinking, and maxTurns configure Pi launches, not explicit agent commands");
	}
	if (options.agent) {
		return {
			command: options.agent,
			prompt: options.prompt,
			runtime: options.agent.split(/\s+/)[0] ?? options.agent,
		};
	}
	if (options.thinking && !options.model) throw new Error("bg_agent thinking requires a model");
	const config = await loadConfig(options.configPath ?? defaultConfigPath());
	if (options.role) return resolveProfileLaunch(options, config);
	if (options.model) {
		const identity = selectIdentity(options);
		const native = options.harness === "native" ? buildNativeCommand(identity) : undefined;
		return {
			command: native?.command ?? buildAgentCommand({}, identity, config.defaultAgent, options.label),
			prompt: options.prompt,
			runtime: native?.runtime ?? config.defaultAgent.split(/\s+/)[0] ?? config.defaultAgent,
			...identityDetails(identity),
		};
	}
	if (options.harness === "native") throw new Error("bg_agent native harness requires an explicit model");
	return {
		command: config.defaultAgent,
		prompt: options.prompt,
		runtime: config.defaultAgent.split(/\s+/)[0] ?? config.defaultAgent,
	};
}
