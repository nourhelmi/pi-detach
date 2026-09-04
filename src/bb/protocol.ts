import { type Static, Type } from "typebox";

const Strict = { additionalProperties: false } as const;
const NonEmpty = Type.String({ minLength: 1, maxLength: 4096 });
const Id = Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$" });
const AbsolutePath = Type.String({ minLength: 1, maxLength: 4096, pattern: "^/" });
const Model = Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*/[A-Za-z0-9][A-Za-z0-9._:/-]*$" });
const Reasoning = Type.Union([Type.Literal("none"), Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("xhigh"), Type.Literal("max")]);
const Version = Type.Literal("1");
const Bootstrap = Type.Object({
	role: Id,
	maxTurns: Type.Integer({ minimum: 1, maximum: 100 }),
	allowSubagents: Type.Boolean(),
}, Strict);

export const BbAgentStartRequestSchema = Type.Object({
	version: Version,
	runId: Id,
	logicalParentThreadId: Id,
	projectId: Id,
	environmentId: Id,
	hostId: Id,
	cwd: AbsolutePath,
	label: NonEmpty,
	prompt: Type.String({ minLength: 1, maxLength: 1_000_000 }),
	providerId: Type.Literal("pi"),
	model: Model,
	reasoning: Reasoning,
	resultPath: Type.Optional(AbsolutePath),
	bootstrap: Type.Optional(Bootstrap),
	continuation: Type.Optional(Type.Boolean()),
}, Strict);

export const BbAgentStartResponseSchema = Type.Object({
	version: Version,
	runId: Id,
	threadId: Id,
	logicalParentThreadId: Id,
	hostId: Id,
	projectId: Id,
	environmentId: Id,
	providerId: Type.Literal("pi"),
	model: Model,
	reasoning: Reasoning,
	cwd: AbsolutePath,
}, Strict);

export const BbAgentWaitRequestSchema = Type.Object({
	version: Version,
	runId: Id,
	threadId: Id,
	until: Type.Union([Type.Literal("active"), Type.Literal("idle")]),
}, Strict);

export const BbAgentWaitResponseSchema = Type.Object({
	version: Version,
	runId: Id,
	threadId: Id,
	transportState: Type.Union([Type.Literal("active"), Type.Literal("idle"), Type.Literal("error"), Type.Literal("stopped")]),
	logicalDescendants: Type.Union([Type.Literal("none"), Type.Literal("live"), Type.Literal("indeterminate")]),
}, Strict);

export const BbAgentStopRequestSchema = Type.Object({ version: Version, runId: Id, threadId: Id }, Strict);
export const BbAgentStopResponseSchema = Type.Object({ version: Version, stopped: Type.Literal(true) }, Strict);
export const BbWakeAuthorizeRequestSchema = Type.Object({
	version: Version,
	runId: Id,
	threadId: Id,
	logicalParentThreadId: Id,
	settlementGeneration: Type.String({ pattern: "^[a-f0-9]{64}$" }),
}, Strict);
export const BbWakeAuthorizeResponseSchema = Type.Object({
	version: Version,
	state: Type.Union([Type.Literal("pending"), Type.Literal("claimed"), Type.Literal("sent"), Type.Literal("unknown")]),
}, Strict);

export const BbBootstrapClaimRequestSchema = Type.Object({ version: Version, token: Type.String({ pattern: "^[A-Za-z0-9_-]{32,4096}$" }), threadId: Id }, Strict);
export const BbBootstrapClaimResponseSchema = Type.Object({
	version: Version,
	role: Id,
	runDir: AbsolutePath,
	maxTurns: Type.Integer({ minimum: 1, maximum: 100 }),
	launchModel: Model,
	launchThinking: Reasoning,
	allowSubagents: Type.Boolean(),
}, Strict);

export type BbAgentStartRequest = Static<typeof BbAgentStartRequestSchema>;
export type BbAgentStartResponse = Static<typeof BbAgentStartResponseSchema>;
export type BbAgentWaitRequest = Static<typeof BbAgentWaitRequestSchema>;
export type BbAgentWaitResponse = Static<typeof BbAgentWaitResponseSchema>;
export type BbAgentStopRequest = Static<typeof BbAgentStopRequestSchema>;
export type BbAgentStopResponse = Static<typeof BbAgentStopResponseSchema>;
export type BbWakeAuthorizeRequest = Static<typeof BbWakeAuthorizeRequestSchema>;
export type BbWakeAuthorizeResponse = Static<typeof BbWakeAuthorizeResponseSchema>;
export type BbBootstrapClaimRequest = Static<typeof BbBootstrapClaimRequestSchema>;
export type BbBootstrapClaimResponse = Static<typeof BbBootstrapClaimResponseSchema>;

export const BB_PROTOCOL_SCHEMAS = {
	"/v1/agents/start": [BbAgentStartRequestSchema, BbAgentStartResponseSchema],
	"/v1/agents/wait": [BbAgentWaitRequestSchema, BbAgentWaitResponseSchema],
	"/v1/agents/stop": [BbAgentStopRequestSchema, BbAgentStopResponseSchema],
	"/v1/wakes/authorize": [BbWakeAuthorizeRequestSchema, BbWakeAuthorizeResponseSchema],
	"/v1/bootstrap/claim": [BbBootstrapClaimRequestSchema, BbBootstrapClaimResponseSchema],
} as const;
