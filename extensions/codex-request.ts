import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { arch, homedir, release, type as osType } from "node:os";
import { join } from "node:path";
import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const PROVIDER_MODE_HEADER = "X-Pi-Codex-Request-Mode";
const RESPONSES_LITE_HEADER = "X-OpenAI-Internal-Codex-Responses-Lite";
const CODEX_PROTOCOL_VERSION = "0.146.0-alpha.13";
const CODEX_BETA_FEATURES = "remote_compaction_v2";
const PROVIDER_MODES = ["lite", "official", "off"] as const;

type ProviderMode = (typeof PROVIDER_MODES)[number];
type ProviderModeStatus = ProviderMode | "mixed";

interface CodexClientIdentity {
	installationId: string;
	userAgent: string;
}

interface CodexTurnIdentity {
	sessionId: string;
	windowId: string;
	metadataJson: string;
	clientMetadata: Record<string, string>;
}

interface LoadedModelsFile {
	path: string;
	mode: number;
	data: Record<string, unknown>;
	providers: Record<string, unknown>;
}

// Protocol baseline: @openai/codex 0.146.0-alpha.13.
// Keep this adapter aligned with codex-rs/core/src/client.rs::build_responses_request,
// codex-rs/core/src/responses_metadata.rs, and core/tests/suite/responses_lite.rs.

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function abortRequest(ctx: ExtensionContext, error: unknown): never {
	ctx.abort();
	throw error instanceof Error ? error : new Error(String(error));
}

function findRecordKey(record: Record<string, unknown>, name: string): string | undefined {
	const normalizedName = name.toLowerCase();
	return Object.keys(record).find((key) => key.toLowerCase() === normalizedName);
}

function findHeaderKey(headers: Record<string, string | null>, name: string): string | undefined {
	return findRecordKey(headers, name);
}

function removeHeader(headers: Record<string, string | null>, name: string): string | null | undefined {
	const key = findHeaderKey(headers, name);
	if (key === undefined) return undefined;
	const value = headers[key];
	headers[key] = null;
	return value;
}

function setHeader(headers: Record<string, string | null>, name: string, value: string): void {
	const key = findHeaderKey(headers, name);
	if (key !== undefined && key !== name) headers[key] = null;
	headers[name] = value;
}

async function loadModelsFile(): Promise<LoadedModelsFile> {
	const path = join(getAgentDir(), "models.json");
	const [raw, fileInfo] = await Promise.all([readFile(path, "utf8"), stat(path)]);
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error(`Failed to parse ${path}`, { cause: error });
	}
	if (!isRecord(parsed) || !isRecord(parsed.providers)) {
		throw new Error(`${path} must contain a providers object`);
	}
	return {
		path,
		mode: fileInfo.mode & 0o777,
		data: parsed,
		providers: parsed.providers,
	};
}

function getProviderObject(
	modelsFile: LoadedModelsFile,
	provider: string,
	create: boolean,
): Record<string, unknown> | undefined {
	const value = modelsFile.providers[provider];
	if (value === undefined && create) {
		const created: Record<string, unknown> = {};
		modelsFile.providers[provider] = created;
		return created;
	}
	if (value === undefined) return undefined;
	if (!isRecord(value)) {
		throw new Error(`Provider ${provider} in ${modelsFile.path} must be an object`);
	}
	return value;
}

function getConfiguredHeaders(owner: Record<string, unknown>, label: string): Record<string, unknown> | undefined {
	if (owner.headers === undefined) return undefined;
	if (!isRecord(owner.headers)) {
		throw new Error(`${label}.headers must be an object`);
	}
	return owner.headers;
}

function readConfiguredMarker(owner: Record<string, unknown>, label: string): "lite" | "official" | undefined {
	const headers = getConfiguredHeaders(owner, label);
	if (!headers) return undefined;
	const key = findRecordKey(headers, PROVIDER_MODE_HEADER);
	if (key === undefined) return undefined;
	const value = headers[key];
	if (value !== "lite" && value !== "official") {
		throw new Error(`${label}.${key} must be either \"lite\" or \"official\"`);
	}
	return value;
}

function visitProviderModelConfigs(
	providerObject: Record<string, unknown>,
	provider: string,
	visit: (model: Record<string, unknown>, label: string) => void,
): void {
	if (providerObject.models !== undefined) {
		if (!Array.isArray(providerObject.models)) {
			throw new Error(`providers.${provider}.models must be an array`);
		}
		for (const [index, model] of providerObject.models.entries()) {
			if (!isRecord(model)) {
				throw new Error(`providers.${provider}.models[${index}] must be an object`);
			}
			visit(model, `providers.${provider}.models[${index}]`);
		}
	}

	if (providerObject.modelOverrides !== undefined) {
		if (!isRecord(providerObject.modelOverrides)) {
			throw new Error(`providers.${provider}.modelOverrides must be an object`);
		}
		for (const [modelId, modelOverride] of Object.entries(providerObject.modelOverrides)) {
			if (!isRecord(modelOverride)) {
				throw new Error(`providers.${provider}.modelOverrides.${modelId} must be an object`);
			}
			visit(modelOverride, `providers.${provider}.modelOverrides.${modelId}`);
		}
	}
}

function getConfiguredModeStatus(modelsFile: LoadedModelsFile, provider: string): ProviderModeStatus {
	const providerObject = getProviderObject(modelsFile, provider, false);
	if (!providerObject) return "off";
	const baseMode: ProviderMode = readConfiguredMarker(providerObject, `providers.${provider}`) ?? "off";
	const effectiveModes = new Set<ProviderMode>([baseMode]);
	visitProviderModelConfigs(providerObject, provider, (model, label) => {
		effectiveModes.add(readConfiguredMarker(model, label) ?? baseMode);
	});
	return effectiveModes.size === 1 ? [...effectiveModes][0] : "mixed";
}

function removeConfiguredMarker(owner: Record<string, unknown>, label: string): boolean {
	const headers = getConfiguredHeaders(owner, label);
	if (!headers) return false;
	const key = findRecordKey(headers, PROVIDER_MODE_HEADER);
	if (key === undefined) return false;
	delete headers[key];
	if (Object.keys(headers).length === 0) delete owner.headers;
	return true;
}

function setConfiguredProviderMode(modelsFile: LoadedModelsFile, provider: string, mode: ProviderMode): boolean {
	const before = JSON.stringify(modelsFile.data);
	const providerObject = getProviderObject(modelsFile, provider, mode !== "off");
	if (!providerObject) return false;

	removeConfiguredMarker(providerObject, `providers.${provider}`);
	visitProviderModelConfigs(providerObject, provider, (model, label) => {
		removeConfiguredMarker(model, label);
	});

	if (mode !== "off") {
		let headers = getConfiguredHeaders(providerObject, `providers.${provider}`);
		if (!headers) {
			headers = {};
			providerObject.headers = headers;
		}
		headers[PROVIDER_MODE_HEADER] = mode;
	}
	return JSON.stringify(modelsFile.data) !== before;
}

async function writeModelsFile(modelsFile: LoadedModelsFile): Promise<void> {
	const temporaryPath = `${modelsFile.path}.${process.pid}.${randomUUID()}.tmp`;
	let temporaryFileExists = false;
	try {
		await writeFile(temporaryPath, `${JSON.stringify(modelsFile.data, null, 2)}\n`, {
			encoding: "utf8",
			flag: "wx",
			mode: modelsFile.mode,
		});
		temporaryFileExists = true;
		await rename(temporaryPath, modelsFile.path);
		temporaryFileExists = false;
	} finally {
		if (temporaryFileExists) await rm(temporaryPath, { force: true });
	}
}

async function getConfiguredProviderIds(): Promise<string[]> {
	const modelsFile = await loadModelsFile();
	return Object.keys(modelsFile.providers).sort();
}

function getResponsesProviderIds(ctx: ExtensionContext): string[] {
	const providerApis = new Map<string, Set<string>>();
	for (const model of ctx.modelRegistry.getAll()) {
		const apis = providerApis.get(model.provider) ?? new Set<string>();
		apis.add(model.api);
		providerApis.set(model.provider, apis);
	}
	return [...providerApis]
		.filter(([, apis]) => apis.size === 1 && apis.has("openai-responses"))
		.map(([provider]) => provider)
		.sort();
}

function loadCodexProtocolVersion(): string {
	const versionOutput = execFileSync("codex", ["--version"], {
		encoding: "utf8",
		timeout: 5000,
	}).trim();
	const versionMatch = /^codex-cli\s+(\S+)$/.exec(versionOutput);
	if (!versionMatch) {
		throw new Error(`Unexpected codex --version output: ${versionOutput}`);
	}
	const version = versionMatch[1];
	if (version !== CODEX_PROTOCOL_VERSION) {
		throw new Error(
			`Codex request adapter baseline ${CODEX_PROTOCOL_VERSION} does not match installed Codex ${version}; update the adapter before sending`,
		);
	}
	return version;
}

function loadCodexClientIdentity(version: string): CodexClientIdentity {
	const codexHome = process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
	const installationId = readFileSync(join(codexHome, "installation_id"), "utf8").trim();
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(installationId)) {
		throw new Error(`Invalid Codex installation ID in ${join(codexHome, "installation_id")}`);
	}

	const architecture = arch() === "x64" ? "x86_64" : arch();
	const terminal = process.env.TERM?.trim() || "unknown-terminal";
	return {
		installationId,
		userAgent: `codex_exec/${version} (${osType()} ${release()}; ${architecture}) ${terminal} (codex_exec; ${version})`,
	};
}

function createCodexTurnIdentity(ctx: ExtensionContext, client: CodexClientIdentity): CodexTurnIdentity {
	const sessionId = ctx.sessionManager.getSessionId();
	const turnId = randomUUID();
	const windowId = `${sessionId}:0`;
	const metadataJson = JSON.stringify({
		installation_id: client.installationId,
		session_id: sessionId,
		thread_id: sessionId,
		turn_id: turnId,
		window_id: windowId,
		request_kind: "turn",
		thread_source: "user",
		sandbox: "seccomp",
		turn_started_at_unix_ms: Date.now(),
	});
	return {
		sessionId,
		windowId,
		metadataJson,
		clientMetadata: {
			turn_id: turnId,
			"x-codex-installation-id": client.installationId,
			session_id: sessionId,
			"x-codex-window-id": windowId,
			"x-codex-turn-metadata": metadataJson,
			thread_id: sessionId,
		},
	};
}

function applyOfficialCodexHeaders(
	headers: Record<string, string | null>,
	client: CodexClientIdentity,
	turn: CodexTurnIdentity,
): void {
	removeHeader(headers, "session_id");
	setHeader(headers, "Originator", "codex_exec");
	setHeader(headers, "User-Agent", client.userAgent);
	setHeader(headers, "session-id", turn.sessionId);
	setHeader(headers, "thread-id", turn.sessionId);
	setHeader(headers, "x-client-request-id", turn.sessionId);
	setHeader(headers, "x-codex-beta-features", CODEX_BETA_FEATURES);
	setHeader(headers, "x-codex-window-id", turn.windowId);
	setHeader(headers, "x-codex-turn-metadata", turn.metadataJson);
}

function normalizeInputItem(item: unknown): unknown {
	if (!isRecord(item)) return item;
	if (item.type !== undefined && item.type !== "message") return item;
	if (item.role !== "developer" && item.role !== "system" && item.role !== "user") return item;

	let content = item.content;
	if (typeof content === "string") {
		content = [{ type: "input_text", text: content }];
	} else if (!Array.isArray(content)) {
		throw new Error(`Codex Responses Lite expected ${String(item.role)} message content`);
	}

	return {
		...item,
		type: "message",
		role: item.role === "system" ? "developer" : item.role,
		content,
	};
}

function toResponsesLitePayload(value: unknown): Record<string, unknown> {
	if (!isRecord(value)) {
		throw new Error("Codex Responses Lite expected an OpenAI Responses payload object");
	}
	if (!Array.isArray(value.input)) {
		throw new Error("Codex Responses Lite expected payload.input to be an array");
	}
	if (value.input.some((item) => isRecord(item) && item.type === "additional_tools")) {
		throw new Error("Codex Responses Lite payload was already transformed");
	}
	if (value.tools !== undefined && !Array.isArray(value.tools)) {
		throw new Error("Codex Responses Lite expected payload.tools to be an array");
	}
	if (value.instructions !== undefined && typeof value.instructions !== "string") {
		throw new Error("Codex Responses Lite expected payload.instructions to be a string");
	}
	if (value.reasoning !== undefined && !isRecord(value.reasoning)) {
		throw new Error("Codex Responses Lite expected payload.reasoning to be an object");
	}

	const input: unknown[] = [
		{
			type: "additional_tools",
			role: "developer",
			tools: value.tools ?? [],
		},
	];
	if (value.instructions) {
		input.push({
			type: "message",
			role: "developer",
			content: [{ type: "input_text", text: value.instructions }],
		});
	}
	input.push(...value.input.map(normalizeInputItem));

	const payload: Record<string, unknown> = {
		...value,
		input,
		tool_choice: "auto",
		parallel_tool_calls: false,
		reasoning: { ...(value.reasoning ?? {}), context: "all_turns" },
	};
	delete payload.instructions;
	delete payload.tools;
	delete payload.max_output_tokens;
	delete payload.prompt_cache_options;
	delete payload.prompt_cache_retention;
	delete payload.temperature;
	return payload;
}

export default function (pi: ExtensionAPI) {
	const providerModes = new Map<string, ProviderMode>();
	let codexVersion: string | undefined;
	let codexClient: CodexClientIdentity | undefined;
	let codexTurn: CodexTurnIdentity | undefined;
	let responsesProviderIds: string[] = [];
	const getCodexVersion = (): string => (codexVersion ??= loadCodexProtocolVersion());

	const getProviderArgumentCompletions = async (prefix: string) => {
		const providers = responsesProviderIds.length > 0 ? responsesProviderIds : await getConfiguredProviderIds();
		const normalizedPrefix = prefix.trim();
		const items = providers
			.filter((provider) => provider.includes(normalizedPrefix))
			.map((provider) => ({ value: provider, label: provider }));
		return items.length > 0 ? items : null;
	};

	const getModeArgumentCompletions = async (prefix: string) => {
		const separator = prefix.indexOf(" ");
		if (separator === -1) {
			const providers = responsesProviderIds.length > 0 ? responsesProviderIds : await getConfiguredProviderIds();
			const values = ["list", ...providers];
			const items = values
				.filter((value) => value.includes(prefix.trim()))
				.map((value) => ({ value, label: value }));
			return items.length > 0 ? items : null;
		}

		const provider = prefix.slice(0, separator).trim();
		const modePrefix = prefix.slice(separator + 1).trim();
		if (!provider || modePrefix.includes(" ")) return null;
		const items = PROVIDER_MODES.filter((mode) => mode.startsWith(modePrefix)).map((mode) => ({
			value: `${provider} ${mode}`,
			label: mode,
		}));
		return items.length > 0 ? items : null;
	};

	const configureProvider = async (
		ctx: ExtensionCommandContext,
		provider: string,
		mode: ProviderMode,
	): Promise<void> => {
		await ctx.waitForIdle();
		const modelsFile = await loadModelsFile();
		const knownProviders = new Set([
			...Object.keys(modelsFile.providers),
			...ctx.modelRegistry.getAll().map((model) => model.provider),
		]);
		if (!knownProviders.has(provider)) {
			throw new Error(`Unknown model provider: ${provider}`);
		}
		if (mode !== "off" && !getResponsesProviderIds(ctx).includes(provider)) {
			throw new Error(`Provider ${provider} does not exclusively use the openai-responses API`);
		}
		if (mode !== "off") getCodexVersion();
		if (mode === "official") codexClient ??= loadCodexClientIdentity(getCodexVersion());

		const changed = setConfiguredProviderMode(modelsFile, provider, mode);
		if (changed) {
			await writeModelsFile(modelsFile);
			await ctx.modelRegistry.refresh();
			const refreshError = ctx.modelRegistry.getError();
			if (refreshError) throw new Error(`Failed to refresh models.json: ${refreshError}`);
			responsesProviderIds = getResponsesProviderIds(ctx);
		}
		providerModes.delete(provider);
		codexTurn = undefined;
		ctx.ui.notify(
			changed ? `${provider} 已设置为 Codex ${mode} 模式` : `${provider} 已经是 Codex ${mode} 模式`,
			"info",
		);
	};

	const showProviderModes = async (ctx: ExtensionCommandContext): Promise<void> => {
		const modelsFile = await loadModelsFile();
		const providers = [...new Set([...responsesProviderIds, ...Object.keys(modelsFile.providers)])].sort();
		const lines = providers.map((provider) => `${provider}: ${getConfiguredModeStatus(modelsFile, provider)}`);
		ctx.ui.notify(lines.join("\n"), "info");
	};

	const chooseProvider = async (ctx: ExtensionCommandContext): Promise<string | undefined> => {
		responsesProviderIds = getResponsesProviderIds(ctx);
		if (responsesProviderIds.length === 0) {
			throw new Error("No provider exclusively using openai-responses is configured");
		}
		const currentProvider = ctx.model?.provider;
		const providers = [...responsesProviderIds].sort((left, right) => {
			if (left === currentProvider) return -1;
			if (right === currentProvider) return 1;
			return left.localeCompare(right);
		});
		return ctx.ui.select("选择 Model Provider", providers);
	};

	pi.registerCommand("codex-mode", {
		description: "查看或配置 Model Provider 的 Codex 请求模式",
		getArgumentCompletions: getModeArgumentCompletions,
		handler: async (args, ctx) => {
			const parts = args.trim() ? args.trim().split(/\s+/) : [];
			if (parts[0] === "list") {
				if (parts.length !== 1) throw new Error("Usage: /codex-mode list");
				await showProviderModes(ctx);
				return;
			}
			if (parts.length > 2) {
				throw new Error("Usage: /codex-mode [provider] [lite|official|off]");
			}

			const provider = parts[0] || (await chooseProvider(ctx));
			if (!provider) return;
			let mode = parts[1] as ProviderMode | undefined;
			if (!mode) {
				const selected = await ctx.ui.select("选择 Codex 请求模式", [...PROVIDER_MODES]);
				if (!selected) return;
				mode = selected as ProviderMode;
			}
			if (!PROVIDER_MODES.includes(mode)) {
				throw new Error(`Invalid Codex mode: ${mode}`);
			}
			await configureProvider(ctx, provider, mode);
		},
	});

	const registerModeShortcut = (name: string, mode: ProviderMode, description: string): void => {
		pi.registerCommand(name, {
			description,
			getArgumentCompletions: getProviderArgumentCompletions,
			handler: async (args, ctx) => {
				const parts = args.trim() ? args.trim().split(/\s+/) : [];
				if (parts.length > 1) throw new Error(`Usage: /${name} [provider]`);
				const provider = parts[0] || ctx.model?.provider;
				if (!provider) throw new Error(`/${name} requires a provider when no model is selected`);
				await configureProvider(ctx, provider, mode);
			},
		});
	};

	registerModeShortcut("codex-lite", "lite", "为当前或指定 provider 启用 Codex Lite 协议");
	registerModeShortcut("codex-official", "official", "为当前或指定 provider 启用完整 Codex 身份");
	registerModeShortcut("codex-off", "off", "关闭当前或指定 provider 的 Codex 请求适配");

	pi.on("session_start", (_event, ctx) => {
		responsesProviderIds = getResponsesProviderIds(ctx);
	});

	pi.on("agent_start", () => {
		codexTurn = undefined;
	});
	pi.on("agent_end", () => {
		codexTurn = undefined;
	});

	pi.on("before_provider_headers", (event, ctx) => {
		const markerValue = removeHeader(event.headers, PROVIDER_MODE_HEADER);
		const provider = ctx.model?.provider;
		if (!provider) {
			if (markerValue !== undefined) {
				abortRequest(ctx, new Error("Codex request mode requires a selected provider"));
			}
			return;
		}
		if (markerValue !== undefined && markerValue !== "lite" && markerValue !== "official") {
			abortRequest(
				ctx,
				new Error(`${PROVIDER_MODE_HEADER} must be either \"lite\" or \"official\" for provider ${provider}`),
			);
		}
		if (markerValue !== undefined && ctx.model?.api !== "openai-responses") {
			abortRequest(
				ctx,
				new Error(`${PROVIDER_MODE_HEADER} requires the openai-responses API for provider ${provider}`),
			);
		}

		const mode: ProviderMode = markerValue ?? "off";
		// "official" is explicit per-provider authorization to send Codex installation/session identity.
		providerModes.set(provider, mode);
		if (mode === "off") return;

		try {
			getCodexVersion();
			setHeader(event.headers, RESPONSES_LITE_HEADER, "true");
			if (mode === "lite") {
				setHeader(event.headers, "Originator", "pi");
				return;
			}

			codexClient ??= loadCodexClientIdentity(getCodexVersion());
			codexTurn ??= createCodexTurnIdentity(ctx, codexClient);
			applyOfficialCodexHeaders(event.headers, codexClient, codexTurn);
		} catch (error) {
			abortRequest(ctx, error);
		}
	});

	pi.on("before_provider_request", (event, ctx) => {
		const provider = ctx.model?.provider;
		if (!provider) return;

		const mode = providerModes.get(provider);
		if (mode === undefined) {
			return abortRequest(ctx, new Error(`Codex request adapter did not observe headers for provider ${provider}`));
		}
		if (mode === "off") return;
		if (ctx.model?.api !== "openai-responses") {
			return abortRequest(
				ctx,
				new Error(`${PROVIDER_MODE_HEADER} requires the openai-responses API for provider ${provider}`),
			);
		}

		try {
			const payload = toResponsesLitePayload(event.payload);
			if (mode === "lite") return payload;
			if (!codexTurn) {
				throw new Error(`Codex identity was not initialized for provider ${provider}`);
			}
			if (payload.client_metadata !== undefined && !isRecord(payload.client_metadata)) {
				throw new Error("Codex request expected payload.client_metadata to be an object");
			}
			return {
				...payload,
				client_metadata: {
					...(payload.client_metadata ?? {}),
					...codexTurn.clientMetadata,
				},
			};
		} catch (error) {
			return abortRequest(ctx, error);
		}
	});
}
