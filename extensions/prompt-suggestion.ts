import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { GhostEditor } from "./ghost-editor.js";
import { parseModelSpec, Predictor } from "./predictor.js";

const DEFAULT_MODEL = "anthropic/claude-haiku-4-5-20251001";

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

	pi.registerCommand("suggest", {
		description: "Toggle prompt suggestions: /suggest on | off",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "" || arg === "on") {
				enabled = true;
			} else if (arg === "off") {
				enabled = false;
				predictor?.cancel();
				editor?.clearGhost();
			} else {
				ctx.ui.notify(`Usage: /suggest on|off (got "${arg}")`, "warning");
				return;
			}
			ctx.ui.notify(`Prompt suggestions: ${enabled ? "on" : "off"}`, "info");
		},
	});

	pi.registerCommand("suggest-model", {
		description: "Set suggestion model: /suggest-model <provider>/<modelId>",
		handler: async (args, ctx) => {
			const spec = args.trim();
			if (!spec) {
				const current = predictor?.modelSpec ?? "(unset)";
				ctx.ui.notify(`Current suggestion model: ${current}`, "info");
				return;
			}
			const parsed = parseModelSpec(spec);
			if (!parsed) {
				ctx.ui.notify(
					"Format: provider/modelId (e.g. anthropic/claude-haiku-4-5-20251001)",
					"warning",
				);
				return;
			}
			const model = ctx.modelRegistry.find(parsed.provider, parsed.modelId);
			if (!model) {
				ctx.ui.notify(`Model ${spec} not found in registry`, "error");
				return;
			}
			predictor?.setModelSpec(spec);
			ctx.ui.notify(`Suggestion model: ${spec}`, "info");
		},
	});

	pi.on("session_start", (_event, ctx) => {
		const flagEnabled = pi.getFlag("suggest");
		enabled = flagEnabled !== false;
		const flagModel = pi.getFlag("suggest-model");
		const modelSpec = typeof flagModel === "string" && flagModel ? flagModel : DEFAULT_MODEL;

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
		if (!enabled) return;
		if (!editor || !predictor) return;
		if (!ctx.hasUI) return;
		if (!ctx.isIdle()) return;
		if (ctx.hasPendingMessages()) return;
		if (ctx.ui.getEditorText() !== "") return;
		if (!predictor.sawTurnInThisSession) return;

		const suggestion = await predictor.predict(event.messages);
		if (!suggestion) return;
		// Re-check after await: user may have started typing or submitted while we waited.
		if (!ctx.isIdle()) return;
		if (ctx.ui.getEditorText() !== "") return;

		editor.setGhost(suggestion);
	});
}
