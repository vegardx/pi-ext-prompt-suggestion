import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { GhostEditor } from "./ghost-editor.js";
import { parseModelSpec, Predictor } from "./predictor.js";

const DEFAULT_MODEL = "anthropic/claude-haiku-4-5-20251001";
const CONFIG_PATH = join(homedir(), ".pi", "agent", "prompt-suggestion.json");

interface PersistedConfig {
	modelSpec?: string;
	enabled?: boolean;
}

function loadPersistedConfig(): PersistedConfig {
	try {
		const raw = readFileSync(CONFIG_PATH, "utf8");
		const parsed = JSON.parse(raw);
		if (typeof parsed === "object" && parsed !== null) return parsed as PersistedConfig;
	} catch {
		// File missing or unreadable — fine, caller uses defaults.
	}
	return {};
}

function savePersistedConfig(config: PersistedConfig): void {
	try {
		mkdirSync(dirname(CONFIG_PATH), { recursive: true });
		writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
	} catch {
		// Best-effort; persistence is an ergonomic improvement, not load-bearing.
	}
}

export default function (pi: ExtensionAPI): void {
	pi.registerFlag("suggest", {
		type: "boolean",
		default: true,
		description: "Enable ghost-text prompt suggestions",
	});
	pi.registerFlag("suggest-model", {
		type: "string",
		default: DEFAULT_MODEL,
		description: "provider/modelId used for prompt suggestions",
	});

	let editor: GhostEditor | undefined;
	let predictor: Predictor | undefined;
	let enabled = true;

	const persist = () => {
		savePersistedConfig({
			modelSpec: predictor?.modelSpec,
			enabled,
		});
	};

	const OFF_OPTION = "(off — disable suggestions)";

	pi.registerCommand("suggest", {
		description: "Pick a suggestion model or turn off suggestions",
		handler: async (_args, ctx) => {
			const available = ctx.modelRegistry.getAvailable();
			if (available.length === 0) {
				ctx.ui.notify(
					"No models have configured auth. Set an API key first (e.g. ANTHROPIC_API_KEY) or run /login.",
					"warning",
				);
				return;
			}
			const current = predictor?.modelSpec ?? "";
			const modelOptions = available.map((m) => {
				const label = `${m.provider}/${m.id}`;
				return enabled && label === current ? `${label} (current)` : label;
			});
			const options = [...modelOptions, OFF_OPTION];
			const picked = await ctx.ui.select("Suggestions:", options);
			if (!picked) return;

			if (picked === OFF_OPTION) {
				enabled = false;
				predictor?.cancel();
				editor?.clearGhost();
				persist();
				ctx.ui.notify("Prompt suggestions: off", "info");
				return;
			}
			const chosen = picked.replace(/ \(current\)$/, "");
			predictor?.setModelSpec(chosen);
			enabled = true;
			persist();
			ctx.ui.notify(`Prompt suggestions: on (${chosen})`, "info");
		},
	});

	pi.registerCommand("suggest-status", {
		description: "Show diagnostic state of prompt suggestions",
		handler: async (_args, ctx) => {
			const lines: string[] = [];
			lines.push(`enabled: ${enabled}`);
			lines.push(`editor installed: ${editor ? "yes" : "no"}`);
			lines.push(`predictor: ${predictor ? "yes" : "no"}`);
			lines.push(`seen real turn: ${predictor?.sawTurnInThisSession ? "yes" : "no"}`);
			const spec = predictor?.modelSpec ?? "(unset)";
			lines.push(`model spec: ${spec}`);
			const parsed = predictor ? parseModelSpec(predictor.modelSpec) : null;
			if (parsed) {
				const model = ctx.modelRegistry.find(parsed.provider, parsed.modelId);
				lines.push(`model in registry: ${model ? "yes" : "no"}`);
				if (model) {
					lines.push(`configured auth: ${ctx.modelRegistry.hasConfiguredAuth(model) ? "yes" : "no"}`);
				}
			} else if (predictor) {
				lines.push(`model in registry: parse-error`);
			}
			lines.push(`idle: ${ctx.isIdle() ? "yes" : "no"}`);
			lines.push(`pending messages: ${ctx.hasPendingMessages() ? "yes" : "no"}`);
			lines.push(`editor buffer empty: ${ctx.ui.getEditorText() === "" ? "yes" : "no"}`);
			if (predictor) {
				lines.push("");
				lines.push(`last predict status: ${predictor.lastStatus}`);
				if (predictor.lastAgentEndAt) {
					const agoMs = Date.now() - predictor.lastAgentEndAt;
					lines.push(`last agent_end fired: ${Math.round(agoMs / 1000)}s ago`);
				} else {
					lines.push(`last agent_end fired: never`);
				}
				if (predictor.lastAt) {
					const agoMs = Date.now() - predictor.lastAt;
					lines.push(`last predict at: ${Math.round(agoMs / 1000)}s ago`);
				}
				if (predictor.lastStopReason) lines.push(`last stopReason: ${predictor.lastStopReason}`);
				if (predictor.lastTrimmedCount !== null) lines.push(`last trimmed count: ${predictor.lastTrimmedCount}`);
				if (predictor.lastContentTypes) lines.push(`last content types: ${predictor.lastContentTypes}`);
				if (predictor.lastRawText !== null) {
					lines.push(`last raw (trunc 200): ${JSON.stringify(predictor.lastRawText)}`);
				}
				if (predictor.lastSanitized !== null) {
					lines.push(`last sanitized: ${JSON.stringify(predictor.lastSanitized)}`);
				}
				if (predictor.lastErrorMessage) lines.push(`last error: ${predictor.lastErrorMessage}`);
			}
			ctx.ui.notify(`prompt-suggestion status:\n${lines.join("\n")}`, "info");
		},
	});

	pi.on("session_start", (_event, ctx) => {
		const persisted = loadPersistedConfig();

		// Enabled precedence: persisted > flag > default(true).
		// Flag is checked via user-explicit presence; a bare default(true) shouldn't
		// override the persisted off-state.
		const flagEnabled = pi.getFlag("suggest");
		if (typeof persisted.enabled === "boolean") {
			enabled = persisted.enabled;
		} else {
			enabled = flagEnabled !== false;
		}

		// Model precedence: persisted > flag > DEFAULT_MODEL.
		const flagModel = pi.getFlag("suggest-model");
		const modelSpec =
			persisted.modelSpec && typeof persisted.modelSpec === "string"
				? persisted.modelSpec
				: typeof flagModel === "string" && flagModel
					? flagModel
					: DEFAULT_MODEL;

		predictor = new Predictor(modelSpec, ctx);
		editor = undefined;

		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			editor = new GhostEditor(tui, theme, keybindings);
			return editor;
		});
	});

	// Only predict after a real user turn. Session-resume fires a synthetic
	// agent_end on load; without this flag we'd immediately ship the restored
	// conversation to Haiku and guess a message the user already answered.
	pi.on("turn_start", () => {
		if (predictor) predictor.sawTurnInThisSession = true;
	});

	// Belt-and-suspenders: the editor's handleInput already clears the ghost
	// and cancels for interactive submissions. This covers RPC/extension
	// sources that bypass the editor entirely.
	pi.on("input", () => {
		predictor?.cancel();
		editor?.clearGhost();
	});

	pi.on("session_shutdown", () => {
		predictor?.cancel();
		predictor = undefined;
		editor?.clearGhost();
		editor = undefined;
	});

	pi.on("agent_end", async (event, ctx) => {
		if (predictor) predictor.lastAgentEndAt = Date.now();
		if (!enabled) {
			if (predictor) predictor.lastStatus = "gate: disabled";
			return;
		}
		if (!editor) {
			if (predictor) predictor.lastStatus = "gate: no-editor";
			return;
		}
		if (!predictor) return;
		if (!ctx.hasUI) {
			predictor.lastStatus = "gate: no-ui";
			return;
		}
		// Intentionally NOT checking ctx.isIdle() here — agent_end means the agent
		// ended; Pi's internal streaming flag may not flip until after this handler
		// runs, so isIdle() is racy at this point. getEditorText() below is the real
		// signal for "user has started typing".
		if (ctx.hasPendingMessages()) {
			predictor.lastStatus = "gate: pending-messages";
			return;
		}
		if (ctx.ui.getEditorText() !== "") {
			predictor.lastStatus = "gate: buffer-not-empty";
			return;
		}
		if (!predictor.sawTurnInThisSession) {
			predictor.lastStatus = "gate: no-real-turn-seen";
			return;
		}

		const suggestion = await predictor.predict(event.messages);
		if (!suggestion) return;
		// Post-await: if the user started typing during the Haiku call, don't paint
		// over their in-progress input. isIdle() is skipped here for the same
		// racy-flag reason as the pre-check above.
		if (ctx.ui.getEditorText() !== "") {
			predictor.lastStatus = "post: buffer-not-empty";
			return;
		}

		editor.setGhost(suggestion);
	});
}
