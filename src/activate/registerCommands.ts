import * as vscode from "vscode"
import delay from "delay"

import type { CommandId } from "@roo-code/types"
import { TelemetryService } from "@roo-code/telemetry"

import { Package } from "../shared/package"
import { getCommand } from "../utils/commands"
import { ClineProvider } from "../core/webview/ClineProvider"
import { ContextProxy } from "../core/config/ContextProxy"
import { focusPanel } from "../utils/focusPanel"
import { handleNewTask } from "./handleTask"
import { CodeIndexManager } from "../services/code-index/manager"
import { CODE_INDEX_V2_ENGINE_ID } from "../services/code-index-v2/shared/constants"
import {
	CodeIndexEvalRunner,
	formatRetrievalEvalReport,
	rooCodeBenchmarkFixtures,
} from "../services/code-index-v2/eval"
import { IndexDebugLoggerV2 } from "../services/code-index-v2"
import { importSettingsWithFeedback } from "../core/config/importExport"
import { MdmService } from "../services/mdm/MdmService"
import { t } from "../i18n"

/**
 * Helper to get the visible ClineProvider instance or log if not found.
 */
export function getVisibleProviderOrLog(outputChannel: vscode.OutputChannel): ClineProvider | undefined {
	const visibleProvider = ClineProvider.getVisibleInstance()
	if (!visibleProvider) {
		outputChannel.appendLine("Cannot find any visible Roo Code instances.")
		return undefined
	}
	return visibleProvider
}

// Store panel references in both modes
let sidebarPanel: vscode.WebviewView | undefined = undefined
let tabPanel: vscode.WebviewPanel | undefined = undefined

/**
 * Get the currently active panel
 * @returns WebviewPanel或WebviewView
 */
export function getPanel(): vscode.WebviewPanel | vscode.WebviewView | undefined {
	return tabPanel || sidebarPanel
}

/**
 * Set panel references
 */
export function setPanel(
	newPanel: vscode.WebviewPanel | vscode.WebviewView | undefined,
	type: "sidebar" | "tab",
): void {
	if (type === "sidebar") {
		sidebarPanel = newPanel as vscode.WebviewView
		tabPanel = undefined
	} else {
		tabPanel = newPanel as vscode.WebviewPanel
		sidebarPanel = undefined
	}
}

export type RegisterCommandOptions = {
	context: vscode.ExtensionContext
	outputChannel: vscode.OutputChannel
	provider: ClineProvider
}

export async function runCodeIndexEvalForCurrentWorkspace({
	context,
	outputChannel,
	provider,
}: RegisterCommandOptions): Promise<void> {
	const manager = CodeIndexManager.getInstance(context)
	if (!manager) {
		outputChannel.appendLine("[CodeIndexEval] No workspace manager is available.")
		outputChannel.show(true)
		return
	}

	if (!manager.isInitialized) {
		await manager.initialize(provider.contextProxy)
	}

	if (!manager.isFeatureEnabled) {
		outputChannel.appendLine("[CodeIndexEval] Code indexing is disabled for the current workspace.")
		outputChannel.show(true)
		return
	}

	if (!manager.isFeatureConfigured) {
		outputChannel.appendLine("[CodeIndexEval] Code indexing is not configured for the current workspace.")
		outputChannel.show(true)
		return
	}

	if (manager.selectedEngine !== CODE_INDEX_V2_ENGINE_ID) {
		outputChannel.appendLine(
			`[CodeIndexEval] The active code index engine is '${manager.selectedEngine}'. Switch to '${CODE_INDEX_V2_ENGINE_ID}' to run the V2 retrieval eval.`,
		)
		outputChannel.show(true)
		return
	}

	if (!manager.isInitialized) {
		outputChannel.appendLine("[CodeIndexEval] Code indexing is not initialized for the current workspace.")
		outputChannel.show(true)
		return
	}

	outputChannel.appendLine(
		`[CodeIndexEval] Running Roo Code retrieval benchmark against the current workspace index (${rooCodeBenchmarkFixtures.length} queries)...`,
	)
	outputChannel.show(true)

	const runner = new CodeIndexEvalRunner(
		{
			engine: CODE_INDEX_V2_ENGINE_ID,
			start: async () => {},
			refreshAll: async () => {},
			stop: async () => {},
			clear: async () => {},
			search: (query, limit) => manager.searchIndex(query, limit),
			searchDebug: async (query, limit) => {
				const trace = await manager.searchIndexDebug(query, limit)
				if (!trace) {
					throw new Error("Detailed V2 search trace is not available for the current workspace.")
				}
				return trace
			},
			enqueuePathsChanged: async () => {},
			getStatus: async () => ({
				engine: CODE_INDEX_V2_ENGINE_ID,
				state: "idle",
				message: "Eval adapter",
			}),
			getWarningDetails: async () => ({ total: 0, items: [] }),
			getOversizedFileDetails: async () => ({ total: 0, actionable: 0, items: [] }),
			retryWarningFiles: async () => ({ retriedFiles: 0 }),
		},
		{
			onQueryStart: ({ index, total, id, query }) => {
				outputChannel.appendLine(`[CodeIndexEval] Query ${index}/${total}: [${id}] ${query}`)
			},
			onQueryComplete: ({ index, total, id, firstRelevantRank, totalMs }) => {
				const rankLabel = firstRelevantRank === null ? "miss" : `rank ${firstRelevantRank}`
				outputChannel.appendLine(
					`[CodeIndexEval] Query ${index}/${total} complete: [${id}] ${rankLabel} (${totalMs.toFixed(1)} ms)`,
				)
			},
		},
	)

	try {
		const report = await runner.run(rooCodeBenchmarkFixtures)
		outputChannel.appendLine(formatRetrievalEvalReport(report))
	} catch (error) {
		outputChannel.appendLine(
			`[CodeIndexEval] Failed to run retrieval eval: ${error instanceof Error ? error.message : String(error)}`,
		)
		throw error
	}
}

export const registerCommands = (options: RegisterCommandOptions) => {
	const { context } = options

	for (const [id, callback] of Object.entries(getCommandsMap(options))) {
		const command = getCommand(id as CommandId)
		context.subscriptions.push(vscode.commands.registerCommand(command, callback))
	}
}

const getCommandsMap = ({ context, outputChannel, provider }: RegisterCommandOptions): Record<CommandId, any> => ({
	activationCompleted: () => {},
	cloudButtonClicked: () => {
		const visibleProvider = getVisibleProviderOrLog(outputChannel)

		if (!visibleProvider) {
			return
		}

		TelemetryService.instance.captureTitleButtonClicked("cloud")

		visibleProvider.postMessageToWebview({ type: "action", action: "cloudButtonClicked" })
	},
	plusButtonClicked: async () => {
		const visibleProvider = getVisibleProviderOrLog(outputChannel)

		if (!visibleProvider) {
			return
		}

		TelemetryService.instance.captureTitleButtonClicked("plus")

		await visibleProvider.removeClineFromStack()
		await visibleProvider.refreshWorkspace()
		await visibleProvider.postMessageToWebview({ type: "action", action: "chatButtonClicked" })
		// Send focusInput action immediately after chatButtonClicked
		// This ensures the focus happens after the view has switched
		await visibleProvider.postMessageToWebview({ type: "action", action: "focusInput" })
	},
	popoutButtonClicked: () => {
		TelemetryService.instance.captureTitleButtonClicked("popout")

		return openClineInNewTab({ context, outputChannel })
	},
	openInNewTab: () => openClineInNewTab({ context, outputChannel }),
	settingsButtonClicked: () => {
		const visibleProvider = getVisibleProviderOrLog(outputChannel)

		if (!visibleProvider) {
			return
		}

		TelemetryService.instance.captureTitleButtonClicked("settings")

		visibleProvider.postMessageToWebview({ type: "action", action: "settingsButtonClicked" })
		// Also explicitly post the visibility message to trigger scroll reliably
		visibleProvider.postMessageToWebview({ type: "action", action: "didBecomeVisible" })
	},
	historyButtonClicked: () => {
		const visibleProvider = getVisibleProviderOrLog(outputChannel)

		if (!visibleProvider) {
			return
		}

		TelemetryService.instance.captureTitleButtonClicked("history")

		visibleProvider.postMessageToWebview({ type: "action", action: "historyButtonClicked" })
	},
	marketplaceButtonClicked: () => {
		const visibleProvider = getVisibleProviderOrLog(outputChannel)
		if (!visibleProvider) return
		visibleProvider.postMessageToWebview({ type: "action", action: "marketplaceButtonClicked" })
	},
	newTask: handleNewTask,
	setCustomStoragePath: async () => {
		const { promptForCustomStoragePath } = await import("../utils/storage")
		await promptForCustomStoragePath()
	},
	importSettings: async (filePath?: string) => {
		const visibleProvider = getVisibleProviderOrLog(outputChannel)
		if (!visibleProvider) {
			return
		}

		await importSettingsWithFeedback(
			{
				providerSettingsManager: visibleProvider.providerSettingsManager,
				contextProxy: visibleProvider.contextProxy,
				customModesManager: visibleProvider.customModesManager,
				provider: visibleProvider,
			},
			filePath,
		)
	},
	runCodeIndexEval: async () => {
		await runCodeIndexEvalForCurrentWorkspace({ context, outputChannel, provider })
	},
	startCodeIndexing: async () => {
		IndexDebugLoggerV2.log("basic", "CodeIndexCommands", "command-start-indexing-requested")
		const manager = CodeIndexManager.getInstance(context)
		if (!manager) {
			IndexDebugLoggerV2.log("basic", "CodeIndexCommands", "command-start-indexing-no-manager")
			vscode.window.showWarningMessage(t("embeddings:orchestrator.indexingRequiresWorkspace"))
			return
		}

		try {
			const contextProxy = await ContextProxy.getInstance(context)
			await manager.setWorkspaceEnabled(true)
			await manager.initialize(contextProxy)
			await manager.startIndexing()
			const status = manager.getCurrentStatus()
			IndexDebugLoggerV2.log("basic", "CodeIndexCommands", "command-start-indexing-complete", {
				message: status.message,
			})
			vscode.window.showInformationMessage(status.message || "Code indexing started.")
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			IndexDebugLoggerV2.log("basic", "CodeIndexCommands", "command-start-indexing-failed", {
				errorMessage: message,
			})
			outputChannel.appendLine(`[CodeIndexCommands] Failed to start indexing: ${message}`)
			vscode.window.showErrorMessage(`Failed to start code indexing: ${message}`)
		}
	},
	stopCodeIndexing: async () => {
		IndexDebugLoggerV2.log("basic", "CodeIndexCommands", "command-stop-indexing-requested")
		const managers = CodeIndexManager.getAllInstances()
		if (managers.length === 0) {
			IndexDebugLoggerV2.log("basic", "CodeIndexCommands", "command-stop-indexing-no-manager")
			vscode.window.showWarningMessage(t("embeddings:orchestrator.indexingRequiresWorkspace"))
			return
		}

		try {
			const results = await Promise.allSettled(managers.map((manager) => manager.stopIndexing()))
			const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected")
			if (rejected.length > 0) {
				const message =
					rejected[0]?.reason instanceof Error ? rejected[0].reason.message : String(rejected[0]?.reason)
				IndexDebugLoggerV2.log("basic", "CodeIndexCommands", "command-stop-indexing-failed", {
					managerCount: managers.length,
					errorMessage: message,
				})
				outputChannel.appendLine(`[CodeIndexCommands] Failed to stop indexing: ${message}`)
				vscode.window.showErrorMessage(`Failed to stop code indexing: ${message}`)
				return
			}

			const status = managers[0]?.getCurrentStatus()
			IndexDebugLoggerV2.log("basic", "CodeIndexCommands", "command-stop-indexing-complete", {
				managerCount: managers.length,
				message: status?.message,
			})
			vscode.window.showInformationMessage(status?.message || "Code indexing stopped.")
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			IndexDebugLoggerV2.log("basic", "CodeIndexCommands", "command-stop-indexing-failed", {
				errorMessage: message,
			})
			outputChannel.appendLine(`[CodeIndexCommands] Failed to stop indexing: ${message}`)
			vscode.window.showErrorMessage(`Failed to stop code indexing: ${message}`)
		}
	},
	forceStopCodeIndexing: async () => {
		IndexDebugLoggerV2.log("basic", "CodeIndexCommands", "command-force-stop-indexing-requested")
		outputChannel.appendLine("[CodeIndexCommands] Emergency stop requested.")
		const managers = CodeIndexManager.getAllInstances()
		if (managers.length === 0) {
			IndexDebugLoggerV2.log("basic", "CodeIndexCommands", "command-force-stop-indexing-no-manager")
			vscode.window.showWarningMessage(t("embeddings:orchestrator.indexingRequiresWorkspace"))
			return
		}

		try {
			const results = await Promise.allSettled(managers.map((manager) => manager.stopIndexing()))
			const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected")
			if (rejected.length > 0) {
				const message =
					rejected[0]?.reason instanceof Error ? rejected[0].reason.message : String(rejected[0]?.reason)
				IndexDebugLoggerV2.log("basic", "CodeIndexCommands", "command-force-stop-indexing-failed", {
					managerCount: managers.length,
					errorMessage: message,
				})
				outputChannel.appendLine(`[CodeIndexCommands] Emergency stop failed: ${message}`)
				vscode.window.showErrorMessage(`Emergency stop failed: ${message}`)
				return
			}

			const status = managers[0]?.getCurrentStatus()
			IndexDebugLoggerV2.log("basic", "CodeIndexCommands", "command-force-stop-indexing-complete", {
				managerCount: managers.length,
				message: status?.message,
			})
			outputChannel.appendLine(
				`[CodeIndexCommands] Emergency stop complete: ${status?.message ?? "Indexing stopped."}`,
			)
			vscode.window.showInformationMessage(status?.message || "Code indexing stopped.")
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			IndexDebugLoggerV2.log("basic", "CodeIndexCommands", "command-force-stop-indexing-failed", {
				errorMessage: message,
			})
			outputChannel.appendLine(`[CodeIndexCommands] Emergency stop failed: ${message}`)
			vscode.window.showErrorMessage(`Emergency stop failed: ${message}`)
		}
	},
	focusInput: async () => {
		try {
			await focusPanel(tabPanel, sidebarPanel)

			// Send focus input message only for sidebar panels
			if (sidebarPanel && getPanel() === sidebarPanel) {
				provider.postMessageToWebview({ type: "action", action: "focusInput" })
			}
		} catch (error) {
			outputChannel.appendLine(`Error focusing input: ${error}`)
		}
	},
	focusPanel: async () => {
		try {
			await focusPanel(tabPanel, sidebarPanel)
		} catch (error) {
			outputChannel.appendLine(`Error focusing panel: ${error}`)
		}
	},
	acceptInput: () => {
		const visibleProvider = getVisibleProviderOrLog(outputChannel)

		if (!visibleProvider) {
			return
		}

		visibleProvider.postMessageToWebview({ type: "acceptInput" })
	},
	toggleAutoApprove: async () => {
		const visibleProvider = getVisibleProviderOrLog(outputChannel)

		if (!visibleProvider) {
			return
		}

		visibleProvider.postMessageToWebview({
			type: "action",
			action: "toggleAutoApprove",
		})
	},
})

export const openClineInNewTab = async ({ context, outputChannel }: Omit<RegisterCommandOptions, "provider">) => {
	// (This example uses webviewProvider activation event which is necessary to
	// deserialize cached webview, but since we use retainContextWhenHidden, we
	// don't need to use that event).
	// https://github.com/microsoft/vscode-extension-samples/blob/main/webview-sample/src/extension.ts
	const contextProxy = await ContextProxy.getInstance(context)
	const codeIndexManager = CodeIndexManager.getInstance(context)

	// Get the existing MDM service instance to ensure consistent policy enforcement
	let mdmService: MdmService | undefined
	try {
		mdmService = MdmService.getInstance()
	} catch (error) {
		// MDM service not initialized, which is fine - extension can work without it
		mdmService = undefined
	}

	const tabProvider = new ClineProvider(context, outputChannel, "editor", contextProxy, mdmService)
	const lastCol = Math.max(...vscode.window.visibleTextEditors.map((editor) => editor.viewColumn || 0))

	// Check if there are any visible text editors, otherwise open a new group
	// to the right.
	const hasVisibleEditors = vscode.window.visibleTextEditors.length > 0

	if (!hasVisibleEditors) {
		await vscode.commands.executeCommand("workbench.action.newGroupRight")
	}

	const targetCol = hasVisibleEditors ? Math.max(lastCol + 1, 1) : vscode.ViewColumn.Two

	const newPanel = vscode.window.createWebviewPanel(ClineProvider.tabPanelId, "Roo Code", targetCol, {
		enableScripts: true,
		retainContextWhenHidden: true,
		localResourceRoots: [context.extensionUri],
	})

	// Save as tab type panel.
	setPanel(newPanel, "tab")

	// TODO: Use better svg icon with light and dark variants (see
	// https://stackoverflow.com/questions/58365687/vscode-extension-iconpath).
	newPanel.iconPath = {
		light: vscode.Uri.joinPath(context.extensionUri, "assets", "icons", "panel_light.png"),
		dark: vscode.Uri.joinPath(context.extensionUri, "assets", "icons", "panel_dark.png"),
	}

	await tabProvider.resolveWebviewView(newPanel)

	// Add listener for visibility changes to notify webview
	newPanel.onDidChangeViewState(
		(e) => {
			const panel = e.webviewPanel
			if (panel.visible) {
				panel.webview.postMessage({ type: "action", action: "didBecomeVisible" }) // Use the same message type as in SettingsView.tsx
			}
		},
		null, // First null is for `thisArgs`
		context.subscriptions, // Register listener for disposal
	)

	// Handle panel closing events.
	newPanel.onDidDispose(
		() => {
			setPanel(undefined, "tab")
		},
		null,
		context.subscriptions, // Also register dispose listener
	)

	// Lock the editor group so clicking on files doesn't open them over the panel.
	await delay(100)
	await vscode.commands.executeCommand("workbench.action.lockEditorGroup")

	return tabProvider
}
