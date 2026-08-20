import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

const SAFE_ARGUMENT = /^[a-zA-Z0-9_./:@,+-]+$/;
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
// The model map is the launch-time "intelligence map": which models a caller may
// pick, which reasoning levels each allows, and a character note that guides the
// choice. When the map is non-empty, every Pi launch that names a model (or runs
// a role) must resolve to a mapped model — this is how retired models stay out.
const ModelEntrySchema = Type.Object(
	{
		character: Type.Optional(NonEmptyString),
		thinking: Type.Optional(Type.Array(ThinkingLevelSchema, { minItems: 1 })),
		defaultThinking: Type.Optional(ThinkingLevelSchema),
	},
	{ additionalProperties: false },
);
const AgentProfileSchema = Type.Object(
	{
		description: Type.Optional(NonEmptyString),
		agent: Type.Optional(NonEmptyString),
		skill: Type.Optional(Type.String({ pattern: SAFE_SKILL.source })),
		tools: Type.Optional(Type.Array(NonEmptyString)),
		excludeTools: Type.Optional(Type.Array(NonEmptyString)),
		cliArgs: Type.Optional(Type.Array(NonEmptyString)),
		allowedModels: Type.Optional(Type.Array(NonEmptyString, { minItems: 1 })),
		allowedThinkingByModel: Type.Optional(
			Type.Record(
				Type.String({ pattern: SAFE_ARGUMENT.source }),
				Type.Array(ThinkingLevelSchema, { minItems: 1 }),
			),
		),
		turnCapFlag: Type.Optional(Type.String({ pattern: "^--[a-z0-9][a-z0-9-]*$" })),
		maxTurns: Type.Optional(Type.Integer({ minimum: 1 })),
		requireAnchor: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
);
const AgentProfilesConfigSchema = Type.Object(
	{
		defaultAgent: Type.Optional(NonEmptyString),
		models: Type.Optional(Type.Record(Type.String(), ModelEntrySchema)),
		profiles: Type.Optional(Type.Record(Type.String(), AgentProfileSchema)),
	},
	{ additionalProperties: false },
);

export type AgentProfile = Static<typeof AgentProfileSchema>;
export type ModelEntry = Static<typeof ModelEntrySchema>;
export type ThinkingLevel = Static<typeof ThinkingLevelSchema>;

interface AgentProfilesConfig {
	defaultAgent: string;
	models: Record<string, ModelEntry>;
	profiles: Record<string, AgentProfile>;
}

export interface ResolveAgentLaunchOptions {
	agent?: string;
	role?: string;
	model?: string;
	thinking?: ThinkingLevel;
	maxTurns?: number;
	prompt: string;
	label: string;
	anchor?: string;
	requiredSkills?: string[];
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
	const profiles = parsed.profiles ?? {};
	for (const name of Object.keys(profiles)) {
		if (!SAFE_SKILL.test(name)) throw new Error(`profile name ${name} is not a valid role slug`);
	}
	const models = parsed.models ?? {};
	for (const key of Object.keys(models)) {
		if (!SAFE_ARGUMENT.test(key) || !key.includes("/")) {
			throw new Error(`model map key ${key} must be a safe "provider/model-id" pair`);
		}
	}
	return { defaultAgent: parsed.defaultAgent ?? "pi", models, profiles };
}

async function loadConfig(path: string): Promise<AgentProfilesConfig> {
	const contents = await readConfig(path);
	return contents === undefined
		? { defaultAgent: "pi", models: {}, profiles: {} }
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

function describeModelMap(models: Record<string, ModelEntry>): string {
	const lines = Object.entries(models).map(([id, entry]) => {
		const levels = entry.thinking?.length ? ` [${entry.thinking.join("|")}]` : "";
		const character = entry.character ? ` — ${entry.character}` : "";
		return `- ${id}${levels}${character}`;
	});
	return lines.join("\n") || "none configured";
}

function splitModel(value: string): { provider: string; model: string } {
	const separator = value.indexOf("/");
	if (separator < 1 || separator === value.length - 1) {
		throw new Error(`bg_agent model must be "provider/model-id", got "${value}"`);
	}
	return { provider: value.slice(0, separator), model: value.slice(separator + 1) };
}

/**
 * Resolve the effective model/reasoning/turn-cap for a launch. Model and
 * reasoning are chosen per launch only — profiles never pin a model — and the
 * model map (when configured) is the hard boundary for what is allowed.
 */
function selectIdentity(
	options: ResolveAgentLaunchOptions,
	config: AgentProfilesConfig,
	profile?: AgentProfile,
): LaunchIdentity {
	if (!options.model) {
		throw new Error(
			`bg_agent needs a model chosen from the model map:\n${describeModelMap(config.models)}`,
		);
	}
	const { provider, model } = splitModel(options.model);
	const key = `${provider}/${model}`;
	const entry = config.models[key];
	if (Object.keys(config.models).length && !entry) {
		throw new Error(
			`Model ${key} is not in the model map. Allowed models:\n${describeModelMap(config.models)}`,
		);
	}
	if (profile?.allowedModels && !profile.allowedModels.includes(key)) {
		throw new Error(
			`This role only allows models ${profile.allowedModels.join(", ")}; requested ${key}`,
		);
	}
	const thinking = options.thinking ?? entry?.defaultThinking;
	if (entry?.thinking?.length && (!thinking || !entry.thinking.includes(thinking))) {
		throw new Error(
			`Model ${key} allows thinking ${entry.thinking.join(", ")}; requested ${thinking ?? "none"}`,
		);
	}
	const roleThinking = profile?.allowedThinkingByModel?.[key];
	if (roleThinking?.length && (!thinking || !roleThinking.includes(thinking))) {
		throw new Error(
			`Role allows ${key} thinking ${roleThinking.join(", ")}; requested ${thinking ?? "none"}`,
		);
	}
	const identity: LaunchIdentity = { provider, model };
	if (thinking) identity.thinking = thinking;
	const maxTurns = options.maxTurns ?? profile?.maxTurns;
	if (maxTurns) identity.maxTurns = maxTurns;
	return identity;
}

function buildPiCommand(
	profile: AgentProfile,
	identity: LaunchIdentity,
	defaultAgent: string,
	label: string,
): string {
	const executable = profile.agent ?? defaultAgent;
	const args = [commandArgument(executable, "agent")];
	if (identity.provider) args.push("--provider", commandArgument(identity.provider, "provider"));
	if (identity.model) args.push("--model", commandArgument(identity.model, "model"));
	if (identity.thinking) args.push("--thinking", identity.thinking);
	args.push("--name", sessionName(label));
	if (profile.tools?.length) args.push("--tools", commandArgument(profile.tools.join(","), "tools"));
	if (profile.excludeTools?.length) {
		args.push("--exclude-tools", commandArgument(profile.excludeTools.join(","), "excludeTools"));
	}
	for (const argument of profile.cliArgs ?? []) args.push(commandArgument(argument, "cliArgs"));
	if (profile.turnCapFlag && identity.maxTurns) {
		args.push(profile.turnCapFlag, String(identity.maxTurns));
	}
	return args.join(" ");
}

function rolePrompt(
	options: ResolveAgentLaunchOptions,
	role: string,
	profile: AgentProfile,
	maxTurns: number | undefined,
): string {
	if (profile.requireAnchor && !options.anchor?.trim()) {
		throw new Error(`bg_agent role ${role} requires a concrete anchor`);
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
		"ANCHOR:",
		options.anchor?.trim() || "Return the requested bounded result with direct evidence.",
		"",
		"REQUIRED SKILLS:",
		skills.length ? skills.map((skill) => `- ${skill}`).join("\n") : "- None beyond the role contract.",
	];
	if (maxTurns) packet.push("", `TURN CAP: ${maxTurns}`);
	const body = packet.join("\n");
	return profile.skill ? `/skill:${profile.skill} ${body}` : body;
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
	const identity = selectIdentity(options, config, profile);
	return {
		command: buildPiCommand(profile, identity, config.defaultAgent, options.label),
		prompt: rolePrompt(options, role, profile, identity.maxTurns),
		role,
		runtime: (profile.agent ?? config.defaultAgent).split(/\s+/)[0] ?? "pi",
		...identityDetails(identity),
	};
}

/** Resolve a visible helper launch from an explicit command or a configured Pi role profile. */
export async function resolveAgentLaunch(
	options: ResolveAgentLaunchOptions,
): Promise<ResolvedAgentLaunch> {
	if (options.agent && options.role) throw new Error("Choose either agent or role, not both");
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
	const config = await loadConfig(options.configPath ?? defaultConfigPath());
	if (options.role) return resolveProfileLaunch(options, config);
	if (options.thinking && !options.model) {
		throw new Error("bg_agent thinking requires a model");
	}
	if (options.model) {
		const identity = selectIdentity(options, config);
		return {
			command: buildPiCommand({}, identity, config.defaultAgent, options.label),
			prompt: options.prompt,
			runtime: config.defaultAgent.split(/\s+/)[0] ?? config.defaultAgent,
			...identityDetails(identity),
		};
	}
	return {
		command: config.defaultAgent,
		prompt: options.prompt,
		runtime: config.defaultAgent.split(/\s+/)[0] ?? config.defaultAgent,
	};
}
