import React, { Suspense, lazy, useCallback, useEffect, useRef, useState } from "react"
import { useEvent } from "react-use"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

import { type ExtensionMessage, TelemetryEventName } from "@roo-code/types"

import TranslationProvider from "./i18n/TranslationContext"

import { vscode } from "./utils/vscode"
import { telemetryClient } from "./utils/TelemetryClient"
import { initializeSourceMaps, exposeSourceMapsForDebugging } from "./utils/sourceMapInitializer"
import { ExtensionStateContextProvider, useExtensionState } from "./context/ExtensionStateContext"
import ChatView, { ChatViewRef } from "./components/chat/ChatView"
import type { SettingsViewRef } from "./components/settings/SettingsView"
import ErrorBoundary from "./components/ErrorBoundary"
import { useAddNonInteractiveClickListener } from "./components/ui/hooks/useNonInteractiveClick"
import { TooltipProvider } from "./components/ui/tooltip"
import { STANDARD_TOOLTIP_DELAY } from "./components/ui/standard-tooltip"
import { MarketplaceViewStateManager } from "./components/marketplace/MarketplaceViewStateManager"

type Tab = "settings" | "history" | "chat" | "marketplace" | "cloud"

interface DeleteMessageDialogState {
	isOpen: boolean
	messageTs: number
	hasCheckpoint: boolean
}

interface EditMessageDialogState {
	isOpen: boolean
	messageTs: number
	text: string
	hasCheckpoint: boolean
	images?: string[]
}

const tabsByMessageAction: Partial<Record<NonNullable<ExtensionMessage["action"]>, Tab>> = {
	chatButtonClicked: "chat",
	settingsButtonClicked: "settings",
	historyButtonClicked: "history",
	marketplaceButtonClicked: "marketplace",
	cloudButtonClicked: "cloud",
}

const HistoryView = lazy(() => import("./components/history/HistoryView"))
const SettingsView = lazy(() => import("./components/settings/SettingsView"))
const WelcomeView = lazy(() => import("./components/welcome/WelcomeViewProvider"))
const MarketplaceView = lazy(() =>
	import("./components/marketplace/MarketplaceView").then((module) => ({ default: module.MarketplaceView })),
)
const CloudView = lazy(() => import("./components/cloud/CloudView").then((module) => ({ default: module.CloudView })))
const CheckpointRestoreDialog = lazy(() =>
	import("./components/chat/CheckpointRestoreDialog").then((module) => ({ default: module.CheckpointRestoreDialog })),
)
const DeleteMessageDialog = lazy(() =>
	import("./components/chat/MessageModificationConfirmationDialog").then((module) => ({
		default: module.DeleteMessageDialog,
	})),
)
const EditMessageDialog = lazy(() =>
	import("./components/chat/MessageModificationConfirmationDialog").then((module) => ({
		default: module.EditMessageDialog,
	})),
)

const postBootMarker = (marker: string) => {
	vscode.postMessage({
		type: "webviewBootMarker" as any,
		text: marker,
	})
}

const TabFallback = ({ label }: { label: string }) => <div style={{ padding: "12px 16px", opacity: 0.75 }}>{label}</div>

const App = () => {
	const {
		didHydrateState,
		showWelcome,
		shouldShowAnnouncement,
		telemetrySetting,
		telemetryKey,
		machineId,
		cloudUserInfo,
		cloudIsAuthenticated,
		cloudApiUrl,
		cloudOrganizations,
		renderContext,
		mdmCompliant,
	} = useExtensionState()

	const [showAnnouncement, setShowAnnouncement] = useState(false)
	const [tab, setTab] = useState<Tab>("chat")
	const marketplaceStateManagerRef = useRef<MarketplaceViewStateManager | null>(null)

	const [deleteMessageDialogState, setDeleteMessageDialogState] = useState<DeleteMessageDialogState>({
		isOpen: false,
		messageTs: 0,
		hasCheckpoint: false,
	})

	const [editMessageDialogState, setEditMessageDialogState] = useState<EditMessageDialogState>({
		isOpen: false,
		messageTs: 0,
		text: "",
		hasCheckpoint: false,
		images: [],
	})

	const settingsRef = useRef<SettingsViewRef>(null)
	const chatViewRef = useRef<ChatViewRef>(null)

	useEffect(() => {
		postBootMarker("app-shell-mounted")
	}, [])

	const switchTab = useCallback(
		(newTab: Tab) => {
			// Only check MDM compliance if mdmCompliant is explicitly false (meaning there's an MDM policy and user is non-compliant)
			// If mdmCompliant is undefined or true, allow tab switching
			if (mdmCompliant === false && newTab !== "cloud") {
				// Notify the user that authentication is required by their organization
				vscode.postMessage({ type: "showMdmAuthRequiredNotification" })
				return
			}

			setCurrentSection(undefined)
			setCurrentMarketplaceTab(undefined)

			if (settingsRef.current?.checkUnsaveChanges) {
				settingsRef.current.checkUnsaveChanges(() => setTab(newTab))
			} else {
				setTab(newTab)
			}
		},
		[mdmCompliant],
	)

	const [currentSection, setCurrentSection] = useState<string | undefined>(undefined)
	const [currentMarketplaceTab, setCurrentMarketplaceTab] = useState<string | undefined>(undefined)
	const onMessage = useCallback(
		(e: MessageEvent) => {
			const message: ExtensionMessage = e.data

			if (message.type === "action" && message.action) {
				// Handle switchTab action with tab parameter
				if (message.action === "switchTab" && message.tab) {
					const targetTab = message.tab as Tab
					switchTab(targetTab)
					// Extract targetSection from values if provided
					const targetSection = message.values?.section as string | undefined
					setCurrentSection(targetSection)
					setCurrentMarketplaceTab(undefined)
				} else {
					// Handle other actions using the mapping
					const newTab = tabsByMessageAction[message.action]
					const section = message.values?.section as string | undefined
					const marketplaceTab = message.values?.marketplaceTab as string | undefined

					if (newTab) {
						switchTab(newTab)
						setCurrentSection(section)
						setCurrentMarketplaceTab(marketplaceTab)
					}
				}
			}

			if (message.type === "showDeleteMessageDialog" && message.messageTs) {
				setDeleteMessageDialogState({
					isOpen: true,
					messageTs: message.messageTs,
					hasCheckpoint: message.hasCheckpoint || false,
				})
			}

			if (message.type === "showEditMessageDialog" && message.messageTs && message.text) {
				setEditMessageDialogState({
					isOpen: true,
					messageTs: message.messageTs,
					text: message.text,
					hasCheckpoint: message.hasCheckpoint || false,
					images: message.images || [],
				})
			}

			if (message.type === "acceptInput") {
				chatViewRef.current?.acceptInput()
			}
		},
		[switchTab],
	)

	useEvent("message", onMessage)

	useEffect(() => {
		if (didHydrateState) {
			postBootMarker("extension-state-hydrated")
		}
	}, [didHydrateState])

	useEffect(() => {
		if (shouldShowAnnouncement && tab === "chat") {
			setShowAnnouncement(true)
			vscode.postMessage({ type: "didShowAnnouncement" })
		}
	}, [shouldShowAnnouncement, tab])

	useEffect(() => {
		if (didHydrateState) {
			const timer = window.setTimeout(() => {
				telemetryClient.updateTelemetryState(telemetrySetting, telemetryKey, machineId)
				postBootMarker("telemetry-state-synced")
			}, 2_000)

			return () => window.clearTimeout(timer)
		}
	}, [telemetrySetting, telemetryKey, machineId, didHydrateState])

	useEffect(() => {
		if (!didHydrateState) {
			return
		}
		postBootMarker(`tab-mounted:${tab}`)
		if (tab === "chat") {
			postBootMarker("chat-surface-mounted")
		}
	}, [didHydrateState, tab])

	// Initialize source map support for better error reporting
	useEffect(() => {
		if (process.env.PKG_ENABLE_WEBVIEW_SOURCE_MAPS !== "true") {
			return
		}

		const timer = window.setTimeout(() => {
			initializeSourceMaps()
			exposeSourceMapsForDebugging()
			postBootMarker("source-map-debug-enabled")
			console.debug("App initialized")
		}, 1_500)

		return () => window.clearTimeout(timer)
	}, [])

	// Focus the WebView when non-interactive content is clicked (only in editor/tab mode)
	useAddNonInteractiveClickListener(
		useCallback(() => {
			// Only send focus request if we're in editor (tab) mode, not sidebar
			if (renderContext === "editor") {
				vscode.postMessage({ type: "focusPanelRequest" })
			}
		}, [renderContext]),
	)
	// Track marketplace tab views
	useEffect(() => {
		if (tab === "marketplace") {
			telemetryClient.capture(TelemetryEventName.MARKETPLACE_TAB_VIEWED)
		}
	}, [tab])

	if (!didHydrateState) {
		return null
	}

	const getMarketplaceStateManager = () => {
		if (!marketplaceStateManagerRef.current) {
			marketplaceStateManagerRef.current = new MarketplaceViewStateManager()
			postBootMarker("marketplace-state-manager-created")
		}
		return marketplaceStateManagerRef.current
	}

	return showWelcome ? (
		<Suspense fallback={<TabFallback label="Loading welcome..." />}>
			<WelcomeView />
		</Suspense>
	) : (
		<>
			{tab === "settings" && (
				<Suspense fallback={<TabFallback label="Loading settings..." />}>
					<SettingsView ref={settingsRef} onDone={() => setTab("chat")} targetSection={currentSection} />
				</Suspense>
			)}
			{tab === "history" && (
				<Suspense fallback={<TabFallback label="Loading history..." />}>
					<HistoryView onDone={() => switchTab("chat")} />
				</Suspense>
			)}
			{tab === "marketplace" && (
				<Suspense fallback={<TabFallback label="Loading marketplace..." />}>
					<MarketplaceView
						stateManager={getMarketplaceStateManager()}
						onDone={() => switchTab("chat")}
						targetTab={currentMarketplaceTab as "mcp" | "mode" | undefined}
					/>
				</Suspense>
			)}
			{tab === "cloud" && (
				<Suspense fallback={<TabFallback label="Loading cloud..." />}>
					<CloudView
						userInfo={cloudUserInfo}
						isAuthenticated={cloudIsAuthenticated}
						cloudApiUrl={cloudApiUrl}
						organizations={cloudOrganizations}
					/>
				</Suspense>
			)}
			<ChatView
				ref={chatViewRef}
				isHidden={tab !== "chat"}
				showAnnouncement={showAnnouncement}
				hideAnnouncement={() => setShowAnnouncement(false)}
			/>
			{deleteMessageDialogState.isOpen && (
				<Suspense fallback={null}>
					{deleteMessageDialogState.hasCheckpoint ? (
						<CheckpointRestoreDialog
							open={deleteMessageDialogState.isOpen}
							type="delete"
							hasCheckpoint={deleteMessageDialogState.hasCheckpoint}
							onOpenChange={(open: boolean) =>
								setDeleteMessageDialogState((prev) => ({ ...prev, isOpen: open }))
							}
							onConfirm={(restoreCheckpoint: boolean) => {
								vscode.postMessage({
									type: "deleteMessageConfirm",
									messageTs: deleteMessageDialogState.messageTs,
									restoreCheckpoint,
								})
								setDeleteMessageDialogState((prev) => ({ ...prev, isOpen: false }))
							}}
						/>
					) : (
						<DeleteMessageDialog
							open={deleteMessageDialogState.isOpen}
							onOpenChange={(open: boolean) =>
								setDeleteMessageDialogState((prev) => ({ ...prev, isOpen: open }))
							}
							onConfirm={() => {
								vscode.postMessage({
									type: "deleteMessageConfirm",
									messageTs: deleteMessageDialogState.messageTs,
								})
								setDeleteMessageDialogState((prev) => ({ ...prev, isOpen: false }))
							}}
						/>
					)}
				</Suspense>
			)}
			{editMessageDialogState.isOpen && (
				<Suspense fallback={null}>
					{editMessageDialogState.hasCheckpoint ? (
						<CheckpointRestoreDialog
							open={editMessageDialogState.isOpen}
							type="edit"
							hasCheckpoint={editMessageDialogState.hasCheckpoint}
							onOpenChange={(open: boolean) =>
								setEditMessageDialogState((prev) => ({ ...prev, isOpen: open }))
							}
							onConfirm={(restoreCheckpoint: boolean) => {
								vscode.postMessage({
									type: "editMessageConfirm",
									messageTs: editMessageDialogState.messageTs,
									text: editMessageDialogState.text,
									restoreCheckpoint,
								})
								setEditMessageDialogState((prev) => ({ ...prev, isOpen: false }))
							}}
						/>
					) : (
						<EditMessageDialog
							open={editMessageDialogState.isOpen}
							onOpenChange={(open: boolean) =>
								setEditMessageDialogState((prev) => ({ ...prev, isOpen: open }))
							}
							onConfirm={() => {
								vscode.postMessage({
									type: "editMessageConfirm",
									messageTs: editMessageDialogState.messageTs,
									text: editMessageDialogState.text,
									images: editMessageDialogState.images,
								})
								setEditMessageDialogState((prev) => ({ ...prev, isOpen: false }))
							}}
						/>
					)}
				</Suspense>
			)}
		</>
	)
}

const queryClient = new QueryClient()

const AppWithProviders = () => (
	<ErrorBoundary>
		<ExtensionStateContextProvider>
			<TranslationProvider>
				<QueryClientProvider client={queryClient}>
					<TooltipProvider delayDuration={STANDARD_TOOLTIP_DELAY}>
						<App />
					</TooltipProvider>
				</QueryClientProvider>
			</TranslationProvider>
		</ExtensionStateContextProvider>
	</ErrorBoundary>
)

export default AppWithProviders
