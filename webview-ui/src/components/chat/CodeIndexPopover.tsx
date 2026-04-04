import React, { useState, useEffect, useMemo, useCallback, useRef } from "react"
import { Trans } from "react-i18next"
import { z } from "zod"
import {
	VSCodeButton,
	VSCodeTextField,
	VSCodeDropdown,
	VSCodeOption,
	VSCodeLink,
	VSCodeCheckbox,
} from "@vscode/webview-ui-toolkit/react"
import * as ProgressPrimitive from "@radix-ui/react-progress"
import { AlertTriangle } from "lucide-react"

import { type IndexingStatus, type EmbedderProvider, CODEBASE_INDEX_DEFAULTS } from "@roo-code/types"

import { vscode } from "@src/utils/vscode"
import { useExtensionState } from "@src/context/ExtensionStateContext"
import { useAppTranslation } from "@src/i18n/TranslationContext"
import { buildDocLink } from "@src/utils/docLinks"
import { cn } from "@src/lib/utils"
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
	Popover,
	PopoverContent,
	Slider,
	StandardTooltip,
	Button,
} from "@src/components/ui"
import { useRooPortal } from "@src/components/ui/hooks/useRooPortal"
import { useEscapeKey } from "@src/hooks/useEscapeKey"
import { useCopyToClipboard } from "@src/utils/clipboard"
import {
	useOpenRouterModelProviders,
	OPENROUTER_DEFAULT_PROVIDER_NAME,
} from "@src/components/ui/hooks/useOpenRouterModelProviders"

// Default URLs for providers
const DEFAULT_QDRANT_URL = "http://localhost:6333"
const DEFAULT_OLLAMA_URL = "http://localhost:11434"

/**
 * Formats milliseconds into a human-readable ETA string for display.
 * Mirrors the server-side formatEta() in state-manager.ts.
 */
function formatEtaForDisplay(ms: number): string {
	if (ms < 10_000) return "almost done"
	if (ms < 60_000) return `~${Math.round(ms / 1000)}s remaining`
	const minutes = Math.round(ms / 60_000)
	if (minutes < 60) return `~${minutes}m remaining`
	const hours = Math.floor(minutes / 60)
	const remainingMinutes = minutes % 60
	if (remainingMinutes === 0) return `~${hours}h remaining`
	return `~${hours}h ${remainingMinutes}m remaining`
}

function getTelemetryTokenCategory(token: string): string | null {
	if (token.includes("chunks/sec")) return "throughput"
	if (token.includes("avg batch")) return "avg-batch"
	if (token.includes("sync batches")) return "sync-batches"
	if (token.startsWith("CPU ")) return "cpu"

	if (token.startsWith("Memory ")) {
		const normalized = token.toLowerCase()
		if (normalized.includes(" rss")) return "memory-rss"
		if (normalized.includes(" ext")) return "memory-ext"
		if (normalized.includes(" heap")) return "memory-heap"
		return "memory"
	}

	return null
}

function formatCountLabel(count: number, singular: string, plural: string): string {
	return `${count.toLocaleString()} ${count === 1 ? singular : plural}`
}

interface CodeIndexPopoverProps {
	children: React.ReactNode
	indexingStatus: IndexingStatus
}

interface LocalCodeIndexSettings {
	// Global state settings
	codebaseIndexEnabled: boolean
	codebaseIndexQdrantUrl: string
	codebaseIndexEmbedderProvider: EmbedderProvider
	codebaseIndexEmbedderBaseUrl?: string
	codebaseIndexEmbedderModelId: string
	codebaseIndexEmbedderModelDimension?: number // Generic dimension for all providers
	codebaseIndexSearchMaxResults?: number
	codebaseIndexSearchMinScore?: number
	codebaseIndexMaxFiles?: number
	codebaseIndexEmbeddingBatchSize?: number
	codebaseIndexDebugLogging: boolean
	maximumIndexedFilesForFileSearch?: number
	codebaseIndexRespectGitIgnore: boolean

	// Bedrock-specific settings
	codebaseIndexBedrockRegion?: string
	codebaseIndexBedrockProfile?: string

	// Secret settings (start empty, will be loaded separately)
	codeIndexOpenAiKey?: string
	codeIndexQdrantApiKey?: string
	codebaseIndexOpenAiCompatibleBaseUrl?: string
	codebaseIndexOpenAiCompatibleApiKey?: string
	codebaseIndexGeminiApiKey?: string
	codebaseIndexMistralApiKey?: string
	codebaseIndexVercelAiGatewayApiKey?: string
	codebaseIndexOpenRouterApiKey?: string
	codebaseIndexOpenRouterSpecificProvider?: string
}

// Validation schema for codebase index settings
const createValidationSchema = (provider: EmbedderProvider, t: any) => {
	const baseSchema = z.object({
		codebaseIndexEnabled: z.boolean(),
		codebaseIndexQdrantUrl: z
			.string()
			.min(1, t("settings:codeIndex.validation.qdrantUrlRequired"))
			.url(t("settings:codeIndex.validation.invalidQdrantUrl")),
		codeIndexQdrantApiKey: z.string().optional(),
	})

	switch (provider) {
		case "openai":
			return baseSchema.extend({
				codeIndexOpenAiKey: z.string().min(1, t("settings:codeIndex.validation.openaiApiKeyRequired")),
				codebaseIndexEmbedderModelId: z
					.string()
					.min(1, t("settings:codeIndex.validation.modelSelectionRequired")),
			})

		case "ollama":
			return baseSchema.extend({
				codebaseIndexEmbedderBaseUrl: z
					.string()
					.min(1, t("settings:codeIndex.validation.ollamaBaseUrlRequired"))
					.url(t("settings:codeIndex.validation.invalidOllamaUrl")),
				codebaseIndexEmbedderModelId: z.string().min(1, t("settings:codeIndex.validation.modelIdRequired")),
				codebaseIndexEmbedderModelDimension: z
					.number()
					.min(1, t("settings:codeIndex.validation.modelDimensionRequired"))
					.optional(),
			})

		case "openai-compatible":
			return baseSchema.extend({
				codebaseIndexOpenAiCompatibleBaseUrl: z
					.string()
					.min(1, t("settings:codeIndex.validation.baseUrlRequired"))
					.url(t("settings:codeIndex.validation.invalidBaseUrl")),
				codebaseIndexOpenAiCompatibleApiKey: z
					.string()
					.min(1, t("settings:codeIndex.validation.apiKeyRequired")),
				codebaseIndexEmbedderModelId: z.string().min(1, t("settings:codeIndex.validation.modelIdRequired")),
				codebaseIndexEmbedderModelDimension: z
					.number()
					.min(1, t("settings:codeIndex.validation.modelDimensionRequired")),
			})

		case "gemini":
			return baseSchema.extend({
				codebaseIndexGeminiApiKey: z.string().min(1, t("settings:codeIndex.validation.geminiApiKeyRequired")),
				codebaseIndexEmbedderModelId: z
					.string()
					.min(1, t("settings:codeIndex.validation.modelSelectionRequired")),
			})

		case "mistral":
			return baseSchema.extend({
				codebaseIndexMistralApiKey: z.string().min(1, t("settings:codeIndex.validation.mistralApiKeyRequired")),
				codebaseIndexEmbedderModelId: z
					.string()
					.min(1, t("settings:codeIndex.validation.modelSelectionRequired")),
			})

		case "vercel-ai-gateway":
			return baseSchema.extend({
				codebaseIndexVercelAiGatewayApiKey: z
					.string()
					.min(1, t("settings:codeIndex.validation.vercelAiGatewayApiKeyRequired")),
				codebaseIndexEmbedderModelId: z
					.string()
					.min(1, t("settings:codeIndex.validation.modelSelectionRequired")),
			})

		case "bedrock":
			return baseSchema.extend({
				codebaseIndexBedrockRegion: z.string().min(1, t("settings:codeIndex.validation.bedrockRegionRequired")),
				codebaseIndexBedrockProfile: z.string().optional(),
				codebaseIndexEmbedderModelId: z
					.string()
					.min(1, t("settings:codeIndex.validation.modelSelectionRequired")),
			})

		case "openrouter":
			return baseSchema.extend({
				codebaseIndexOpenRouterApiKey: z
					.string()
					.min(1, t("settings:codeIndex.validation.openRouterApiKeyRequired")),
				codebaseIndexEmbedderModelId: z
					.string()
					.min(1, t("settings:codeIndex.validation.modelSelectionRequired")),
			})

		default:
			return baseSchema
	}
}

export const CodeIndexPopover: React.FC<CodeIndexPopoverProps> = ({
	children,
	indexingStatus: externalIndexingStatus,
}) => {
	const SECRET_PLACEHOLDER = "••••••••••••••••"
	const { t } = useAppTranslation()
	const { codebaseIndexConfig, codebaseIndexModels, cwd, apiConfiguration } = useExtensionState()
	const [open, setOpen] = useState(false)
	const [isAdvancedSettingsOpen, setIsAdvancedSettingsOpen] = useState(false)
	const [isSetupSettingsOpen, setIsSetupSettingsOpen] = useState(false)
	const setupSectionRef = useRef<HTMLDivElement | null>(null)
	const advancedSectionRef = useRef<HTMLDivElement | null>(null)

	const [indexingStatus, setIndexingStatus] = useState<IndexingStatus>(externalIndexingStatus)

	const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle")
	const [saveError, setSaveError] = useState<string | null>(null)
	const [warningDetailsState, setWarningDetailsState] = useState<{
		items: NonNullable<IndexingStatus["warningDetails"]>
		total: number
		loading: boolean
		hasMore: boolean
		filter: "all" | "parser_failed" | "failed" | "degraded"
		sort: "severity" | "recent" | "path"
	}>({
		items: externalIndexingStatus.warningDetails ?? [],
		total: externalIndexingStatus.warningDetails?.length ?? 0,
		loading: false,
		hasMore: false,
		filter: "all",
		sort: "severity",
	})
	const [warningDetailsBootstrapped, setWarningDetailsBootstrapped] = useState(false)
	const [warningFilter, setWarningFilter] = useState<"all" | "parser_failed" | "failed" | "degraded">("all")
	const [warningSort, setWarningSort] = useState<"severity" | "recent" | "path">("severity")
	const [retryWarningsPending, setRetryWarningsPending] = useState(false)
	const [retryingWarningPath, setRetryingWarningPath] = useState<string | null>(null)
	const { copyWithFeedback, showCopyFeedback } = useCopyToClipboard()

	// Form validation state
	const [formErrors, setFormErrors] = useState<Record<string, string>>({})

	// Discard changes dialog state
	const [isDiscardDialogShow, setDiscardDialogShow] = useState(false)
	const confirmDialogHandler = useRef<(() => void) | null>(null)

	// Default settings template
	const getDefaultSettings = (): LocalCodeIndexSettings => ({
		codebaseIndexEnabled: true,
		codebaseIndexQdrantUrl: "",
		codebaseIndexEmbedderProvider: "openai",
		codebaseIndexEmbedderBaseUrl: "",
		codebaseIndexEmbedderModelId: "",
		codebaseIndexEmbedderModelDimension: undefined,
		codebaseIndexSearchMaxResults: CODEBASE_INDEX_DEFAULTS.DEFAULT_SEARCH_RESULTS,
		codebaseIndexSearchMinScore: CODEBASE_INDEX_DEFAULTS.DEFAULT_SEARCH_MIN_SCORE,
		codebaseIndexMaxFiles: 100000,
		codebaseIndexEmbeddingBatchSize: 60,
		codebaseIndexDebugLogging: false,
		maximumIndexedFilesForFileSearch: 10000,
		codebaseIndexRespectGitIgnore: true,
		codebaseIndexBedrockRegion: "",
		codebaseIndexBedrockProfile: "",
		codeIndexOpenAiKey: "",
		codeIndexQdrantApiKey: "",
		codebaseIndexOpenAiCompatibleBaseUrl: "",
		codebaseIndexOpenAiCompatibleApiKey: "",
		codebaseIndexGeminiApiKey: "",
		codebaseIndexMistralApiKey: "",
		codebaseIndexVercelAiGatewayApiKey: "",
		codebaseIndexOpenRouterApiKey: "",
		codebaseIndexOpenRouterSpecificProvider: "",
	})

	// Initial settings state - stores the settings when popover opens
	const [initialSettings, setInitialSettings] = useState<LocalCodeIndexSettings>(getDefaultSettings())

	// Current settings state - tracks user changes
	const [currentSettings, setCurrentSettings] = useState<LocalCodeIndexSettings>(getDefaultSettings())

	// Update indexing status from parent
	useEffect(() => {
		setIndexingStatus(externalIndexingStatus)
		setWarningDetailsState((prev) => ({
			...prev,
			items: externalIndexingStatus.warningDetails ?? [],
			total: Math.max(prev.total, externalIndexingStatus.warningDetails?.length ?? 0),
			hasMore:
				(prev.total || 0) > (externalIndexingStatus.warningDetails?.length ?? 0) ||
				(externalIndexingStatus.warningDetails?.length ?? 0) >= 8,
			filter: prev.filter,
			sort: prev.sort,
		}))
	}, [externalIndexingStatus])

	useEffect(() => {
		if (!isSetupSettingsOpen) {
			return
		}
		requestAnimationFrame(() => {
			setupSectionRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" })
		})
	}, [isSetupSettingsOpen])

	useEffect(() => {
		if (!isAdvancedSettingsOpen) {
			return
		}
		requestAnimationFrame(() => {
			advancedSectionRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" })
		})
	}, [isAdvancedSettingsOpen])

	// Initialize settings from global state
	useEffect(() => {
		if (codebaseIndexConfig) {
			const settings = {
				codebaseIndexEnabled: codebaseIndexConfig.codebaseIndexEnabled ?? true,
				codebaseIndexQdrantUrl: codebaseIndexConfig.codebaseIndexQdrantUrl || "",
				codebaseIndexEmbedderProvider: codebaseIndexConfig.codebaseIndexEmbedderProvider || "openai",
				codebaseIndexEmbedderBaseUrl: codebaseIndexConfig.codebaseIndexEmbedderBaseUrl || "",
				codebaseIndexEmbedderModelId: codebaseIndexConfig.codebaseIndexEmbedderModelId || "",
				codebaseIndexEmbedderModelDimension:
					codebaseIndexConfig.codebaseIndexEmbedderModelDimension || undefined,
				codebaseIndexSearchMaxResults:
					codebaseIndexConfig.codebaseIndexSearchMaxResults ?? CODEBASE_INDEX_DEFAULTS.DEFAULT_SEARCH_RESULTS,
				codebaseIndexSearchMinScore:
					codebaseIndexConfig.codebaseIndexSearchMinScore ?? CODEBASE_INDEX_DEFAULTS.DEFAULT_SEARCH_MIN_SCORE,
				codebaseIndexMaxFiles: codebaseIndexConfig.codebaseIndexMaxFiles ?? 100000,
				codebaseIndexEmbeddingBatchSize: codebaseIndexConfig.codebaseIndexEmbeddingBatchSize ?? 60,
				codebaseIndexDebugLogging: codebaseIndexConfig.codebaseIndexDebugLogging ?? false,
				maximumIndexedFilesForFileSearch: codebaseIndexConfig.maximumIndexedFilesForFileSearch ?? 10000,
				codebaseIndexRespectGitIgnore: codebaseIndexConfig.codebaseIndexRespectGitIgnore ?? true,
				codebaseIndexBedrockRegion: codebaseIndexConfig.codebaseIndexBedrockRegion || "",
				codebaseIndexBedrockProfile: codebaseIndexConfig.codebaseIndexBedrockProfile || "",
				codeIndexOpenAiKey: "",
				codeIndexQdrantApiKey: "",
				codebaseIndexOpenAiCompatibleBaseUrl: codebaseIndexConfig.codebaseIndexOpenAiCompatibleBaseUrl || "",
				codebaseIndexOpenAiCompatibleApiKey: "",
				codebaseIndexGeminiApiKey: "",
				codebaseIndexMistralApiKey: "",
				codebaseIndexVercelAiGatewayApiKey: "",
				codebaseIndexOpenRouterApiKey: "",
				codebaseIndexOpenRouterSpecificProvider:
					codebaseIndexConfig.codebaseIndexOpenRouterSpecificProvider || "",
			}
			setInitialSettings(settings)
			setCurrentSettings(settings)

			// Request secret status to check if secrets exist
			vscode.postMessage({ type: "requestCodeIndexSecretStatus" })
		}
	}, [codebaseIndexConfig])

	// Request initial indexing status
	useEffect(() => {
		if (open) {
			vscode.postMessage({ type: "requestIndexingStatus" })
			vscode.postMessage({ type: "requestCodeIndexSecretStatus" })
			setWarningDetailsBootstrapped(false)
		}
		const handleMessage = (event: MessageEvent) => {
			if (event.data.type === "workspaceUpdated") {
				// When workspace changes, request updated indexing status
				if (open) {
					vscode.postMessage({ type: "requestIndexingStatus" })
					vscode.postMessage({ type: "requestCodeIndexSecretStatus" })
				}
			}
		}

		window.addEventListener("message", handleMessage)
		return () => window.removeEventListener("message", handleMessage)
	}, [open])

	const requestWarningDetails = useCallback(
		(offset: number, limit = 20, filter = warningFilter, sort = warningSort) => {
			setWarningDetailsState((prev) => ({ ...prev, loading: true, filter, sort }))
			vscode.postMessage({
				type: "requestIndexingWarningDetails",
				values: { offset, limit, filter, sort },
			})
		},
		[warningFilter, warningSort],
	)

	const resetWarningDetailsState = useCallback(
		(filter = warningFilter, sort = warningSort) => {
			setWarningDetailsBootstrapped(false)
			setWarningDetailsState({
				items: [],
				total: 0,
				loading: false,
				hasMore: false,
				filter,
				sort,
			})
		},
		[warningFilter, warningSort],
	)

	// Use a ref to capture current settings for the save handler
	const currentSettingsRef = useRef(currentSettings)
	currentSettingsRef.current = currentSettings

	// Listen for indexing status updates and save responses
	useEffect(() => {
		const handleMessage = (event: MessageEvent<any>) => {
			if (event.data.type === "indexingStatusUpdate") {
				if (!event.data.values.workspacePath || event.data.values.workspacePath === cwd) {
					setIndexingStatus(event.data.values)
					setRetryWarningsPending(false)
					setRetryingWarningPath(null)
				}
			} else if (event.data.type === "indexingWarningDetails") {
				if (!event.data.values.workspacePath || event.data.values.workspacePath === cwd) {
					setWarningDetailsState((prev) => ({
						items:
							event.data.values.offset > 0
								? [...prev.items, ...event.data.values.items]
								: event.data.values.items,
						total: event.data.values.total,
						loading: false,
						hasMore: event.data.values.hasMore,
						filter: event.data.values.filter,
						sort: event.data.values.sort,
					}))
					if (event.data.values.offset === 0) {
						setWarningDetailsBootstrapped(true)
					}
				}
			} else if (event.data.type === "codeIndexSettingsSaved") {
				if (event.data.success) {
					setSaveStatus("saved")
					// Update initial settings to match current settings after successful save
					// This ensures hasUnsavedChanges becomes false
					const savedSettings = { ...currentSettingsRef.current }
					setInitialSettings(savedSettings)
					// Also update current settings to maintain consistency
					setCurrentSettings(savedSettings)
					// Request secret status to ensure we have the latest state
					// This is important to maintain placeholder display after save

					vscode.postMessage({ type: "requestCodeIndexSecretStatus" })

					setSaveStatus("idle")
				} else {
					setSaveStatus("error")
					setSaveError(event.data.error || t("settings:codeIndex.saveError"))
					// Clear error message after 5 seconds
					setSaveStatus("idle")
					setSaveError(null)
				}
			}
		}

		window.addEventListener("message", handleMessage)
		return () => window.removeEventListener("message", handleMessage)
	}, [t, cwd])

	useEffect(() => {
		if (!open) {
			return
		}
		const warningCount =
			(indexingStatus.degradedRevisions ?? 0) +
			(indexingStatus.terminalFailedRevisions ?? 0) +
			(indexingStatus.terminalFailedParseRevisions ?? 0)
		if (warningCount === 0) {
			setWarningDetailsState({
				items: [],
				total: 0,
				loading: false,
				hasMore: false,
				filter: warningFilter,
				sort: warningSort,
			})
			setWarningDetailsBootstrapped(false)
			return
		}
		if (retryWarningsPending) {
			return
		}
		if (warningCount > 0 && !warningDetailsBootstrapped) {
			requestWarningDetails(0, 20, warningFilter, warningSort)
		}
	}, [
		indexingStatus.degradedRevisions,
		indexingStatus.terminalFailedParseRevisions,
		indexingStatus.terminalFailedRevisions,
		open,
		requestWarningDetails,
		retryWarningsPending,
		warningDetailsBootstrapped,
		warningFilter,
		warningSort,
	])

	// Listen for secret status
	useEffect(() => {
		const handleMessage = (event: MessageEvent) => {
			if (event.data.type === "codeIndexSecretStatus") {
				// Update settings to show placeholders for existing secrets
				const secretStatus = event.data.values

				// Update both current and initial settings based on what secrets exist
				const updateWithSecrets = (prev: LocalCodeIndexSettings): LocalCodeIndexSettings => {
					const updated = { ...prev }

					// Only update to placeholder if the field is currently empty or already a placeholder
					// This preserves user input when they're actively editing
					if (!prev.codeIndexOpenAiKey || prev.codeIndexOpenAiKey === SECRET_PLACEHOLDER) {
						updated.codeIndexOpenAiKey = secretStatus.hasOpenAiKey ? SECRET_PLACEHOLDER : ""
					}
					if (!prev.codeIndexQdrantApiKey || prev.codeIndexQdrantApiKey === SECRET_PLACEHOLDER) {
						updated.codeIndexQdrantApiKey = secretStatus.hasQdrantApiKey ? SECRET_PLACEHOLDER : ""
					}
					if (
						!prev.codebaseIndexOpenAiCompatibleApiKey ||
						prev.codebaseIndexOpenAiCompatibleApiKey === SECRET_PLACEHOLDER
					) {
						updated.codebaseIndexOpenAiCompatibleApiKey = secretStatus.hasOpenAiCompatibleApiKey
							? SECRET_PLACEHOLDER
							: ""
					}
					if (!prev.codebaseIndexGeminiApiKey || prev.codebaseIndexGeminiApiKey === SECRET_PLACEHOLDER) {
						updated.codebaseIndexGeminiApiKey = secretStatus.hasGeminiApiKey ? SECRET_PLACEHOLDER : ""
					}
					if (!prev.codebaseIndexMistralApiKey || prev.codebaseIndexMistralApiKey === SECRET_PLACEHOLDER) {
						updated.codebaseIndexMistralApiKey = secretStatus.hasMistralApiKey ? SECRET_PLACEHOLDER : ""
					}
					if (
						!prev.codebaseIndexVercelAiGatewayApiKey ||
						prev.codebaseIndexVercelAiGatewayApiKey === SECRET_PLACEHOLDER
					) {
						updated.codebaseIndexVercelAiGatewayApiKey = secretStatus.hasVercelAiGatewayApiKey
							? SECRET_PLACEHOLDER
							: ""
					}
					if (
						!prev.codebaseIndexOpenRouterApiKey ||
						prev.codebaseIndexOpenRouterApiKey === SECRET_PLACEHOLDER
					) {
						updated.codebaseIndexOpenRouterApiKey = secretStatus.hasOpenRouterApiKey
							? SECRET_PLACEHOLDER
							: ""
					}

					return updated
				}

				// Only update settings if we're not in the middle of saving
				// After save is complete (saved status), we still want to update to maintain consistency
				if (saveStatus === "idle" || saveStatus === "saved") {
					setCurrentSettings(updateWithSecrets)
					setInitialSettings(updateWithSecrets)
				}
			}
		}

		window.addEventListener("message", handleMessage)
		return () => window.removeEventListener("message", handleMessage)
	}, [saveStatus])

	// Generic comparison function that detects changes between initial and current settings
	const hasUnsavedChanges = useMemo(() => {
		// Get all keys from both objects to handle any field
		const allKeys = [...Object.keys(initialSettings), ...Object.keys(currentSettings)] as Array<
			keyof LocalCodeIndexSettings
		>

		// Use a Set to ensure unique keys
		const uniqueKeys = Array.from(new Set(allKeys))

		for (const key of uniqueKeys) {
			const currentValue = currentSettings[key]
			const initialValue = initialSettings[key]

			// For secret fields, check if the value has been modified from placeholder
			if (currentValue === SECRET_PLACEHOLDER) {
				// If it's still showing placeholder, no change
				continue
			}

			// Compare values - handles all types including undefined
			if (currentValue !== initialValue) {
				return true
			}
		}

		return false
	}, [currentSettings, initialSettings])

	const updateSetting = (key: keyof LocalCodeIndexSettings, value: any) => {
		setCurrentSettings((prev) => ({ ...prev, [key]: value }))
		// Clear validation error for this field when user starts typing
		if (formErrors[key]) {
			setFormErrors((prev) => {
				const newErrors = { ...prev }
				delete newErrors[key]
				return newErrors
			})
		}
	}

	// Validation function
	const validateSettings = (): boolean => {
		const schema = createValidationSchema(currentSettings.codebaseIndexEmbedderProvider, t)

		// Prepare data for validation
		const dataToValidate: any = {}
		for (const [key, value] of Object.entries(currentSettings)) {
			// For secret fields with placeholder values, treat them as valid (they exist in backend)
			if (value === SECRET_PLACEHOLDER) {
				// Add a dummy value that will pass validation for these fields
				if (
					key === "codeIndexOpenAiKey" ||
					key === "codebaseIndexOpenAiCompatibleApiKey" ||
					key === "codebaseIndexGeminiApiKey" ||
					key === "codebaseIndexMistralApiKey" ||
					key === "codebaseIndexVercelAiGatewayApiKey" ||
					key === "codebaseIndexOpenRouterApiKey"
				) {
					dataToValidate[key] = "placeholder-valid"
				}
			} else {
				dataToValidate[key] = value
			}
		}

		try {
			// Validate using the schema
			schema.parse(dataToValidate)
			setFormErrors({})
			return true
		} catch (error) {
			if (error instanceof z.ZodError) {
				const errors: Record<string, string> = {}
				error.errors.forEach((err) => {
					if (err.path[0]) {
						errors[err.path[0] as string] = err.message
					}
				})
				setFormErrors(errors)
			}
			return false
		}
	}

	// Discard changes functionality
	const checkUnsavedChanges = useCallback(
		(then: () => void) => {
			if (hasUnsavedChanges) {
				confirmDialogHandler.current = then
				setDiscardDialogShow(true)
			} else {
				then()
			}
		},
		[hasUnsavedChanges],
	)

	const onConfirmDialogResult = useCallback(
		(confirm: boolean) => {
			if (confirm) {
				// Discard changes: Reset to initial settings
				setCurrentSettings(initialSettings)
				setFormErrors({}) // Clear any validation errors
				confirmDialogHandler.current?.() // Execute the pending action (e.g., close popover)
			}
			setDiscardDialogShow(false)
		},
		[initialSettings],
	)

	// Handle popover close with unsaved changes check
	const handlePopoverClose = useCallback(() => {
		checkUnsavedChanges(() => {
			setOpen(false)
		})
	}, [checkUnsavedChanges])

	// Use the shared ESC key handler hook - respects unsaved changes logic
	useEscapeKey(open, handlePopoverClose)

	const handleSaveSettings = () => {
		// Validate settings before saving
		if (!validateSettings()) {
			return
		}

		setSaveStatus("saving")
		setSaveError(null)

		// Prepare settings to save
		const settingsToSave: any = {}

		// Iterate through all current settings
		for (const [key, value] of Object.entries(currentSettings)) {
			// For secret fields with placeholder, don't send the placeholder
			// but also don't send an empty string - just skip the field
			// This tells the backend to keep the existing secret
			if (value === SECRET_PLACEHOLDER) {
				// Skip sending placeholder values - backend will preserve existing secrets
				continue
			}

			// Include all other fields, including empty strings (which clear secrets)
			settingsToSave[key] = value
		}

		// Always include codebaseIndexEnabled to ensure it's persisted
		settingsToSave.codebaseIndexEnabled = currentSettings.codebaseIndexEnabled

		// Save settings to backend
		vscode.postMessage({
			type: "saveCodeIndexSettingsAtomic",
			codeIndexSettings: settingsToSave,
		})
	}

	const scanSubphase = useMemo(() => {
		const message = indexingStatus.message ?? ""
		if (message.startsWith("Comparing file signatures")) {
			return "signature-compare"
		}
		if (message.startsWith("Walking the workspace")) {
			return "discovery"
		}
		if (message.startsWith("Remote index is empty, rebuilding")) {
			return "remote-rebuild"
		}
		return indexingStatus.phase === "scanning" ? "generic-scan" : null
	}, [indexingStatus.message, indexingStatus.phase])
	const progressPercentage = useMemo(() => {
		// Use block-level progress during embedding (uniform cost per block → accurate ETA)
		if (indexingStatus.phase === "embedding" && indexingStatus.totalBlocks && indexingStatus.totalBlocks > 0) {
			// Clamp to 100% — the estimate can lag behind actual embedded count
			return Math.min(100, Math.round(((indexingStatus.blocksEmbedded ?? 0) / indexingStatus.totalBlocks) * 100))
		}
		if (indexingStatus.phase === "scanning" && scanSubphase === "discovery") {
			const processed = indexingStatus.processedItems ?? 0
			const rawTotal = Math.max(indexingStatus.totalItems ?? 0, processed, 1)
			const guardedTotal = rawTotal <= processed ? Math.max(Math.ceil(processed * 1.1), processed + 1) : rawTotal
			return Math.min(99, Math.round((processed / guardedTotal) * 100))
		}
		// Fall back to legacy fields
		return indexingStatus.totalItems > 0
			? Math.min(100, Math.round((indexingStatus.processedItems / indexingStatus.totalItems) * 100))
			: 0
	}, [
		scanSubphase,
		indexingStatus.phase,
		indexingStatus.blocksEmbedded,
		indexingStatus.totalBlocks,
		indexingStatus.processedItems,
		indexingStatus.totalItems,
	])

	const transformStyleString = `translateX(-${100 - progressPercentage}%)`
	const statusLines = useMemo(
		() =>
			(indexingStatus.message ?? "")
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean),
		[indexingStatus.message],
	)
	const isCurrentStandby = useMemo(
		() =>
			(indexingStatus.systemStatus === "Standby" &&
				/^(?:V2 is current(?: across| after a partial scan of)|V2 mapped )/.test(
					indexingStatus.message ?? "",
				)) ||
			(indexingStatus.systemStatus === "Indexed" &&
				/^Index up-to-date(?:\.| —|$)/.test(indexingStatus.message ?? "")),
		[indexingStatus.message, indexingStatus.systemStatus],
	)
	const statusHeadline = useMemo(() => {
		if (isCurrentStandby) {
			return t("settings:codeIndex.liveWatcherHeadline")
		}
		if (indexingStatus.systemStatus !== "Indexing") {
			return statusLines[0] ?? ""
		}
		if (indexingStatus.phase === "embedding") {
			return "Building embeddings and syncing vectors"
		}
		if (indexingStatus.phase === "scanning") {
			if (scanSubphase === "signature-compare") {
				return "Comparing file signatures"
			}
			if (scanSubphase === "remote-rebuild") {
				return "Rebuilding from local metadata"
			}
			return "Discovering workspace files"
		}
		return statusLines[0] ?? ""
	}, [indexingStatus.phase, indexingStatus.systemStatus, isCurrentStandby, scanSubphase, statusLines, t])
	const statusSupplementalLines = useMemo(() => {
		if (isCurrentStandby) {
			return [statusLines[0], t("settings:codeIndex.liveWatcherDetail")].filter(Boolean)
		}
		if (indexingStatus.systemStatus !== "Indexing") {
			return statusLines.slice(1, 3)
		}

		const detailLines = statusLines.slice(1)
		const summaryLine =
			detailLines.find(
				(line) =>
					line.includes("Parsing ") || line.includes("Streaming ") || line.includes("candidate files found"),
			) ?? detailLines[0]
		const runtimeLine =
			detailLines.find(
				(line) => line.includes(" MB RSS") || line.includes("chunks/sec") || line.includes("CPU "),
			) ?? detailLines[1]

		return [summaryLine, runtimeLine].filter(Boolean).slice(0, 2)
	}, [indexingStatus.systemStatus, isCurrentStandby, statusLines, t])
	const progressCaption = useMemo(() => {
		if (indexingStatus.phase === "embedding") {
			return `${(indexingStatus.blocksEmbedded ?? 0).toLocaleString()} / ${(indexingStatus.totalBlocks ?? 0).toLocaleString()} blocks`
		}
		if (indexingStatus.phase === "scanning") {
			if (scanSubphase === "signature-compare") {
				const checkedFiles = indexingStatus.processedItems ?? 0
				const totalFiles = Math.max(indexingStatus.totalItems ?? 0, checkedFiles, 1)
				return `Comparing signatures... ${checkedFiles.toLocaleString()} / ${totalFiles.toLocaleString()} checked`
			}
			if (scanSubphase === "remote-rebuild") {
				const rebuiltFiles = indexingStatus.processedItems ?? 0
				const totalFiles = Math.max(indexingStatus.totalItems ?? 0, rebuiltFiles, 1)
				return `Rebuilding from local metadata... ${rebuiltFiles.toLocaleString()} / ${totalFiles.toLocaleString()} files`
			}
			const discoveredFiles = indexingStatus.processedItems ?? 0
			const rawEstimatedTotal = Math.max(indexingStatus.totalItems ?? 0, discoveredFiles, 1)
			const estimatedTotal =
				rawEstimatedTotal <= discoveredFiles
					? Math.max(Math.ceil(discoveredFiles * 1.1), discoveredFiles + 1)
					: rawEstimatedTotal
			return `Discovering workspace files... ${discoveredFiles.toLocaleString()} found so far, estimating ~${estimatedTotal.toLocaleString()} total`
		}
		return ""
	}, [
		indexingStatus.blocksEmbedded,
		indexingStatus.phase,
		indexingStatus.processedItems,
		indexingStatus.totalBlocks,
		indexingStatus.totalItems,
		scanSubphase,
	])
	const estimationMetaTokens = useMemo(() => {
		if (indexingStatus.systemStatus !== "Indexing") {
			return []
		}

		const tokens: string[] = []
		if (indexingStatus.estimationConfidence) {
			tokens.push(`${indexingStatus.estimationConfidence} confidence`)
		}
		if (indexingStatus.isBackpressured) {
			tokens.push("Waiting on embeddings")
		}
		return tokens
	}, [indexingStatus.estimationConfidence, indexingStatus.isBackpressured, indexingStatus.systemStatus])
	const resilienceHighlights = useMemo(() => {
		const resumedPendingJobs = indexingStatus.resumedPendingJobs ?? 0
		const warningItems = [
			indexingStatus.retryingParseRevisions
				? formatCountLabel(indexingStatus.retryingParseRevisions, "parser retry", "parser retries")
				: null,
			indexingStatus.terminalFailedParseRevisions
				? formatCountLabel(
						indexingStatus.terminalFailedParseRevisions,
						"parser-failed file",
						"parser-failed files",
					)
				: null,
			indexingStatus.retryingChunks
				? formatCountLabel(indexingStatus.retryingChunks, "retrying chunk", "retrying chunks")
				: null,
			indexingStatus.terminallyFailedChunks
				? formatCountLabel(indexingStatus.terminallyFailedChunks, "failed chunk", "failed chunks")
				: null,
			indexingStatus.degradedRevisions
				? formatCountLabel(indexingStatus.degradedRevisions, "degraded file", "degraded files")
				: null,
			indexingStatus.terminalFailedRevisions
				? formatCountLabel(indexingStatus.terminalFailedRevisions, "failed file", "failed files")
				: null,
		].filter((item): item is string => Boolean(item))

		return {
			resumedPendingJobs,
			warningItems,
		}
	}, [
		indexingStatus.degradedRevisions,
		indexingStatus.resumedPendingJobs,
		indexingStatus.retryingChunks,
		indexingStatus.retryingParseRevisions,
		indexingStatus.terminalFailedParseRevisions,
		indexingStatus.terminalFailedRevisions,
		indexingStatus.terminallyFailedChunks,
	])
	const warningDetails = useMemo(() => warningDetailsState.items, [warningDetailsState.items])
	const warningFilterOptions = useMemo(
		() => [
			{ value: "all" as const, label: "All warnings" },
			{ value: "parser_failed" as const, label: "Parser failures" },
			{ value: "failed" as const, label: "Failed files" },
			{ value: "degraded" as const, label: "Degraded files" },
		],
		[],
	)
	const warningSortOptions = useMemo(
		() => [
			{ value: "severity" as const, label: "Severity" },
			{ value: "recent" as const, label: "Newest" },
			{ value: "path" as const, label: "Path" },
		],
		[],
	)
	const statusTokens = useMemo(
		() =>
			statusSupplementalLines
				.flatMap((line) => line.split(" • "))
				.map((token) => token.trim())
				.filter(Boolean),
		[statusSupplementalLines],
	)
	const identityTokens = useMemo(
		() =>
			statusTokens.filter(
				(token) =>
					token !== statusLines[0] &&
					!token.includes("chunks/sec") &&
					!token.includes("avg batch") &&
					!token.includes("sync batches") &&
					!token.startsWith("Memory ") &&
					!token.startsWith("CPU ") &&
					!token.includes("candidate files found") &&
					!token.includes("Parsing ") &&
					!token.includes("Streaming "),
			),
		[statusLines, statusTokens],
	)
	const telemetryTokens = useMemo(() => {
		const latestByCategory = new Map<string, string>()

		for (const token of statusTokens) {
			const category = getTelemetryTokenCategory(token)
			if (category) {
				latestByCategory.set(category, token)
			}
		}

		const orderedCategories = [
			"memory-ext",
			"memory-heap",
			"memory-rss",
			"cpu",
			"throughput",
			"avg-batch",
			"sync-batches",
			"memory",
		]

		return orderedCategories
			.map((category) => latestByCategory.get(category))
			.filter((token): token is string => Boolean(token))
	}, [statusTokens])
	const shouldShowRefreshAction =
		currentSettings.codebaseIndexEnabled && (indexingStatus.systemStatus === "Indexed" || isCurrentStandby)
	const shouldShowStartAction =
		currentSettings.codebaseIndexEnabled &&
		(indexingStatus.systemStatus === "Error" || (indexingStatus.systemStatus === "Standby" && !isCurrentStandby))

	const getAvailableModels = () => {
		if (!codebaseIndexModels) return []

		const models =
			codebaseIndexModels[currentSettings.codebaseIndexEmbedderProvider as keyof typeof codebaseIndexModels]
		return models ? Object.keys(models) : []
	}

	// Fetch OpenRouter model providers for embedding model
	const { data: openRouterEmbeddingProviders } = useOpenRouterModelProviders(
		currentSettings.codebaseIndexEmbedderProvider === "openrouter"
			? currentSettings.codebaseIndexEmbedderModelId
			: undefined,
		undefined,
		{
			enabled:
				currentSettings.codebaseIndexEmbedderProvider === "openrouter" &&
				!!currentSettings.codebaseIndexEmbedderModelId,
		},
	)

	const portalContainer = useRooPortal("roo-portal")
	const surfaceCardClass =
		"rounded-2xl border border-vscode-dropdown-border/90 bg-[linear-gradient(180deg,rgba(255,255,255,0.035),rgba(255,255,255,0.015))] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"
	const disclosureButtonClass =
		"flex w-full items-center justify-between rounded-2xl border border-vscode-dropdown-border/80 bg-[rgba(255,255,255,0.02)] px-4 py-3 text-left transition-colors hover:bg-[rgba(255,255,255,0.035)] focus:outline-none"
	const disclosurePanelClass = `${surfaceCardClass} mt-3 p-4`
	const sectionLabelClass =
		"text-[10px] font-semibold uppercase tracking-[0.14em] text-vscode-descriptionForeground/70"
	const fieldGroupClass =
		"space-y-2 rounded-xl border border-vscode-dropdown-border/60 bg-[rgba(255,255,255,0.018)] p-3"
	const footerButtonClass =
		"h-10 rounded-full px-4 text-sm font-medium shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] transition-all"
	const footerSecondaryButtonClass = `${footerButtonClass} border border-vscode-dropdown-border/80 bg-[rgba(255,255,255,0.04)] text-vscode-foreground hover:bg-[rgba(255,255,255,0.08)]`
	const footerDestructiveButtonClass = `${footerButtonClass} border border-red-500/25 bg-[rgba(255,120,120,0.08)] text-vscode-foreground hover:bg-[rgba(255,120,120,0.14)]`
	const footerPrimaryButtonClass = `${footerButtonClass} min-w-[96px] bg-primary text-primary-foreground hover:bg-primary/85`
	const footerDisabledButtonClass =
		"h-10 min-w-[96px] rounded-full border border-vscode-dropdown-border/50 bg-[rgba(255,255,255,0.03)] px-4 text-sm font-medium text-vscode-descriptionForeground/70 shadow-none"

	return (
		<>
			<Popover
				open={open}
				onOpenChange={(newOpen) => {
					if (!newOpen) {
						// User is trying to close the popover
						handlePopoverClose()
					} else {
						setOpen(newOpen)
					}
				}}>
				{children}
				<PopoverContent
					className="flex w-[calc(100vw-32px)] max-w-[470px] flex-col overflow-hidden border border-vscode-dropdown-border/90 bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.05),rgba(255,255,255,0.015)_38%,rgba(0,0,0,0.06)_100%)] p-0 shadow-[0_24px_80px_rgba(0,0,0,0.42),inset_0_1px_0_rgba(255,255,255,0.04)] backdrop-blur-xl"
					style={{
						height: "min(88vh, var(--radix-popover-content-available-height))",
						maxHeight: "min(88vh, var(--radix-popover-content-available-height))",
					}}
					align="end"
					alignOffset={0}
					side="top"
					sideOffset={5}
					collisionPadding={16}
					avoidCollisions={true}
					container={portalContainer}>
					<div className="cursor-default flex-shrink-0 border-b border-vscode-dropdown-border/80 bg-[rgba(255,255,255,0.015)] px-5 py-4">
						<div className="mb-2 flex flex-row items-center gap-1 p-0">
							<h4 className="m-0 flex-1 text-[14px] font-semibold tracking-[-0.01em]">
								{t("settings:codeIndex.title")}
							</h4>
						</div>
						<p className="my-0 max-w-[38ch] pr-2 text-[13px] leading-5 text-vscode-descriptionForeground">
							<Trans i18nKey="settings:codeIndex.description">
								<VSCodeLink
									href={buildDocLink("features/experimental/codebase-indexing", "settings")}
									className="inline"
								/>
							</Trans>
						</p>
					</div>

					<div className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-5 py-5 pb-8">
						{/* Status Section */}
						<div className="space-y-2">
							<div className={sectionLabelClass}>{t("settings:codeIndex.statusTitle")}</div>
							<div className={`${surfaceCardClass} p-4`}>
								<div className="flex items-start gap-3">
									<span
										className={cn(
											"mt-1.5 inline-block h-2.5 w-2.5 shrink-0 rounded-full shadow-[0_0_12px_rgba(245,158,11,0.35)]",
											{
												"bg-gray-400":
													indexingStatus.systemStatus === "Standby" && !isCurrentStandby,
												"bg-yellow-500 animate-pulse":
													indexingStatus.systemStatus === "Indexing",
												"bg-green-500":
													indexingStatus.systemStatus === "Indexed" || isCurrentStandby,
												"bg-amber-500 animate-pulse":
													indexingStatus.systemStatus === "Stopping",
												"bg-red-500": indexingStatus.systemStatus === "Error",
											},
										)}
									/>
									<div className="min-w-0 flex-1">
										<div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-vscode-descriptionForeground/70">
											{isCurrentStandby
												? "Live"
												: t(
														`settings:codeIndex.indexingStatuses.${indexingStatus.systemStatus.toLowerCase()}`,
													)}
										</div>
										{statusHeadline && (
											<div className="mt-1 text-[15px] font-semibold leading-5 tracking-[-0.01em]">
												{statusHeadline}
											</div>
										)}
										{(statusSupplementalLines.length > 0 ||
											resilienceHighlights.resumedPendingJobs > 0 ||
											resilienceHighlights.warningItems.length > 0) && (
											<div className="mt-2 space-y-2">
												{statusSupplementalLines[0] && (
													<div className="text-[12px] leading-5 text-vscode-descriptionForeground">
														{statusSupplementalLines[0]}
													</div>
												)}
												{(identityTokens.length > 0 || estimationMetaTokens.length > 0) && (
													<div className="flex flex-wrap gap-1.5">
														{identityTokens.slice(0, 3).map((token) => (
															<span
																key={token}
																className="rounded-full border border-vscode-dropdown-border/80 bg-[rgba(255,255,255,0.03)] px-2.5 py-1 text-[11px] leading-none text-vscode-descriptionForeground/92">
																{token}
															</span>
														))}
														{estimationMetaTokens.map((token) => (
															<span
																key={token}
																className="rounded-full border border-vscode-dropdown-border/80 bg-[rgba(255,255,255,0.03)] px-2.5 py-1 text-[11px] leading-none text-vscode-descriptionForeground/92">
																{token}
															</span>
														))}
													</div>
												)}
												{telemetryTokens.length > 0 && (
													<div className="grid grid-cols-2 gap-2">
														{telemetryTokens.slice(0, 4).map((token) => (
															<div
																key={token}
																className="rounded-xl border border-vscode-dropdown-border/70 bg-[rgba(255,255,255,0.018)] px-2.5 py-2 text-[11px] leading-4 text-vscode-descriptionForeground/88">
																{token}
															</div>
														))}
													</div>
												)}
												{(resilienceHighlights.resumedPendingJobs > 0 ||
													resilienceHighlights.warningItems.length > 0) && (
													<div className="space-y-2">
														{resilienceHighlights.resumedPendingJobs > 0 && (
															<div className="rounded-xl border border-sky-500/20 bg-[rgba(80,168,255,0.08)] px-3 py-2 text-[11px] leading-4 text-vscode-foreground/92">
																Resuming{" "}
																{resilienceHighlights.resumedPendingJobs.toLocaleString()}{" "}
																unfinished
																{" indexing "}
																{resilienceHighlights.resumedPendingJobs === 1
																	? "job"
																	: "jobs"}{" "}
																from the previous run
															</div>
														)}
														{resilienceHighlights.warningItems.length > 0 && (
															<div className="rounded-xl border border-amber-500/20 bg-[rgba(245,158,11,0.08)] px-3 py-2">
																<div className="flex items-center gap-2 text-[11px] font-medium text-vscode-foreground/92">
																	<AlertTriangle className="h-3.5 w-3.5 text-amber-400" />
																	<span>Indexing warnings</span>
																</div>
																<div className="mt-2 flex flex-wrap gap-1.5">
																	{resilienceHighlights.warningItems.map((item) => (
																		<span
																			key={item}
																			className="rounded-full border border-amber-500/20 bg-[rgba(255,255,255,0.05)] px-2.5 py-1 text-[11px] leading-none text-vscode-descriptionForeground/96">
																			{item}
																		</span>
																	))}
																</div>
																{(warningDetailsState.total > 0 ||
																	warningDetailsState.loading ||
																	warningDetailsBootstrapped) && (
																	<div className="mt-3 space-y-2">
																		<div className="flex items-center justify-between gap-2">
																			<div>
																				<div className="text-[11px] font-medium text-vscode-foreground/90">
																					Affected files
																				</div>
																				<div className="mt-1 text-[10px] text-vscode-descriptionForeground/85">
																					Showing{" "}
																					{warningDetails.length.toLocaleString()}{" "}
																					of{" "}
																					{warningDetailsState.total.toLocaleString()}{" "}
																					matching files
																				</div>
																			</div>
																			<button
																				type="button"
																				onClick={() => {
																					setRetryWarningsPending(true)
																					resetWarningDetailsState(
																						warningFilter,
																						warningSort,
																					)
																					vscode.postMessage({
																						type: "retryIndexingWarnings",
																						values: {
																							filter: warningFilter,
																						},
																					})
																				}}
																				disabled={
																					retryWarningsPending ||
																					indexingStatus.systemStatus ===
																						"Indexing"
																				}
																				className="rounded-lg border border-amber-500/30 bg-[rgba(245,158,11,0.12)] px-3 py-1.5 text-[11px] font-medium text-vscode-foreground transition-colors hover:bg-[rgba(245,158,11,0.18)] disabled:cursor-default disabled:opacity-60">
																				{retryWarningsPending
																					? "Retrying affected files..."
																					: warningFilter === "all"
																						? "Retry affected files only"
																						: "Retry filtered files only"}
																			</button>
																		</div>
																		<div className="space-y-2">
																			<div className="flex flex-wrap gap-1">
																				{warningFilterOptions.map((option) => (
																					<button
																						key={option.value}
																						type="button"
																						onClick={() => {
																							setWarningFilter(
																								option.value,
																							)
																							resetWarningDetailsState(
																								option.value,
																								warningSort,
																							)
																						}}
																						className={cn(
																							"rounded-full border px-2 py-1 text-[10px] leading-none transition-colors",
																							warningFilter ===
																								option.value
																								? "border-amber-400/40 bg-[rgba(245,158,11,0.18)] text-vscode-foreground"
																								: "border-vscode-dropdown-border/70 bg-[rgba(255,255,255,0.04)] text-vscode-descriptionForeground/95 hover:bg-[rgba(255,255,255,0.08)]",
																						)}>
																						{option.label}
																					</button>
																				))}
																			</div>
																			<div className="flex flex-wrap gap-1">
																				{warningSortOptions.map((option) => (
																					<button
																						key={option.value}
																						type="button"
																						onClick={() => {
																							setWarningSort(option.value)
																							resetWarningDetailsState(
																								warningFilter,
																								option.value,
																							)
																						}}
																						className={cn(
																							"rounded-full border px-2 py-1 text-[10px] leading-none transition-colors",
																							warningSort === option.value
																								? "border-sky-400/35 bg-[rgba(80,168,255,0.16)] text-vscode-foreground"
																								: "border-vscode-dropdown-border/70 bg-[rgba(255,255,255,0.04)] text-vscode-descriptionForeground/95 hover:bg-[rgba(255,255,255,0.08)]",
																						)}>
																						Sort: {option.label}
																					</button>
																				))}
																			</div>
																		</div>
																		<div className="space-y-2">
																			{warningDetails.length > 0 ? (
																				warningDetails.map((detail) => (
																					<div
																						key={`${detail.state}:${detail.relativePath}`}
																						className="rounded-lg border border-vscode-dropdown-border/60 bg-[rgba(0,0,0,0.08)] px-2.5 py-2 text-[11px] leading-4">
																						<div className="flex flex-wrap items-center gap-2">
																							<span className="font-medium text-vscode-foreground/95">
																								{detail.relativePath}
																							</span>
																							<span className="rounded-full border border-amber-500/20 bg-[rgba(255,255,255,0.05)] px-2 py-0.5 text-[10px] uppercase tracking-[0.08em] text-vscode-descriptionForeground/95">
																								{detail.category ===
																								"parser_failed"
																									? "parser"
																									: detail.state ===
																										  "terminal_failed"
																										? "failed"
																										: detail.state}
																							</span>
																							<div className="ml-auto flex flex-wrap gap-1">
																								<button
																									type="button"
																									onClick={() =>
																										vscode.postMessage(
																											{
																												type: "openFile",
																												text: detail.relativePath,
																											},
																										)
																									}
																									className="rounded-full border border-vscode-dropdown-border/70 bg-[rgba(255,255,255,0.04)] px-2 py-0.5 text-[10px] text-vscode-descriptionForeground/95 transition-colors hover:bg-[rgba(255,255,255,0.08)]">
																									Open
																								</button>
																								<button
																									type="button"
																									onClick={() =>
																										void copyWithFeedback(
																											detail.relativePath,
																										)
																									}
																									className="rounded-full border border-vscode-dropdown-border/70 bg-[rgba(255,255,255,0.04)] px-2 py-0.5 text-[10px] text-vscode-descriptionForeground/95 transition-colors hover:bg-[rgba(255,255,255,0.08)]">
																									{showCopyFeedback
																										? "Copied"
																										: "Copy path"}
																								</button>
																								<button
																									type="button"
																									onClick={() => {
																										setRetryingWarningPath(
																											detail.relativePath,
																										)
																										vscode.postMessage(
																											{
																												type: "retryIndexingWarnings",
																												values: {
																													filter: warningFilter,
																													relativePaths:
																														[
																															detail.relativePath,
																														],
																												},
																											},
																										)
																									}}
																									disabled={
																										retryWarningsPending ||
																										indexingStatus.systemStatus ===
																											"Indexing" ||
																										retryingWarningPath ===
																											detail.relativePath
																									}
																									className="rounded-full border border-amber-500/30 bg-[rgba(245,158,11,0.12)] px-2 py-0.5 text-[10px] text-vscode-foreground transition-colors hover:bg-[rgba(245,158,11,0.18)] disabled:cursor-default disabled:opacity-60">
																									{retryingWarningPath ===
																									detail.relativePath
																										? "Retrying..."
																										: "Retry file"}
																								</button>
																							</div>
																						</div>
																						{detail.failureReason && (
																							<div className="mt-1 text-vscode-descriptionForeground/90">
																								{detail.failureReason}
																							</div>
																						)}
																					</div>
																				))
																			) : (
																				<div className="rounded-lg border border-vscode-dropdown-border/60 bg-[rgba(0,0,0,0.08)] px-2.5 py-2 text-[11px] leading-4 text-vscode-descriptionForeground/90">
																					{warningDetailsState.loading
																						? "Loading affected files..."
																						: "No files match the current warning filter."}
																				</div>
																			)}
																		</div>
																		{warningDetailsState.hasMore && (
																			<button
																				type="button"
																				onClick={() =>
																					requestWarningDetails(
																						warningDetails.length,
																						20,
																						warningFilter,
																						warningSort,
																					)
																				}
																				disabled={warningDetailsState.loading}
																				className="w-full rounded-lg border border-vscode-dropdown-border/70 bg-[rgba(255,255,255,0.04)] px-3 py-2 text-[11px] font-medium text-vscode-foreground transition-colors hover:bg-[rgba(255,255,255,0.08)] disabled:cursor-default disabled:opacity-60">
																				{warningDetailsState.loading
																					? "Loading affected files..."
																					: "Load more affected files"}
																			</button>
																		)}
																	</div>
																)}
															</div>
														)}
													</div>
												)}
											</div>
										)}
									</div>
								</div>

								{/* Index stats when indexed */}
								{indexingStatus.systemStatus === "Indexed" &&
									(indexingStatus.totalFiles || indexingStatus.totalBlocks) && (
										<div className="mt-3 text-xs text-vscode-descriptionForeground">
											{indexingStatus.totalFiles != null &&
												t("settings:codeIndex.indexedFilesCount", {
													count: indexingStatus.totalFiles,
												})}
											{indexingStatus.totalFiles != null &&
												indexingStatus.totalBlocks != null &&
												" · "}
											{indexingStatus.totalBlocks != null &&
												t("settings:codeIndex.indexedBlocksCount", {
													count: indexingStatus.totalBlocks,
												})}
										</div>
									)}

								{indexingStatus.systemStatus === "Indexing" && (
									<div className="mt-4 space-y-3">
										<div className="flex flex-wrap items-center gap-2 text-[11px] text-vscode-descriptionForeground/85">
											{indexingStatus.phase && (
												<span className="rounded-full border border-vscode-dropdown-border/80 bg-[rgba(255,255,255,0.02)] px-2.5 py-1">
													{indexingStatus.phase === "scanning"
														? "Workspace pass"
														: "Embedding pass"}
												</span>
											)}
											{progressCaption && (
												<span className="rounded-full border border-vscode-dropdown-border/80 bg-[rgba(255,255,255,0.02)] px-2.5 py-1">
													{progressCaption}
												</span>
											)}
											{indexingStatus.estimatedTimeRemainingMs != null && (
												<span className="rounded-full border border-vscode-dropdown-border/80 bg-[rgba(255,255,255,0.02)] px-2.5 py-1">
													{formatEtaForDisplay(indexingStatus.estimatedTimeRemainingMs)}
												</span>
											)}
										</div>
										<div className="flex items-center gap-2">
											<ProgressPrimitive.Root
												className="relative h-2.5 w-full min-w-[80px] overflow-hidden rounded-full bg-[rgba(255,255,255,0.06)]"
												value={progressPercentage}>
												<ProgressPrimitive.Indicator
													className="h-full w-full flex-1 bg-[linear-gradient(90deg,rgba(80,168,255,0.9),rgba(128,203,255,0.92))] transition-transform duration-300 ease-in-out"
													style={{
														transform: transformStyleString,
													}}
												/>
											</ProgressPrimitive.Root>
											<span className="min-w-[2.5rem] text-right text-xs font-medium text-vscode-descriptionForeground">
												{progressPercentage}%
											</span>
										</div>
									</div>
								)}
							</div>
						</div>

						{/* Enable/Disable Toggle */}
						<div className={`${surfaceCardClass} mt-5 p-3.5`}>
							<div className="flex items-start justify-between gap-3">
								<div className="space-y-0.5">
									<div className={sectionLabelClass}>Indexer</div>
									<div className="text-sm font-medium leading-5">
										{t("settings:codeIndex.enableLabel")}
									</div>
									<div className="text-xs leading-4 text-vscode-descriptionForeground">
										Turn semantic code search on for this workspace.
									</div>
								</div>
								<div className="flex items-center gap-2">
									<StandardTooltip content={t("settings:codeIndex.enableDescription")}>
										<span className="codicon codicon-info cursor-help text-xs text-vscode-descriptionForeground" />
									</StandardTooltip>
								</div>
							</div>
							<div className="mt-3">
								<VSCodeCheckbox
									checked={currentSettings.codebaseIndexEnabled}
									onChange={(e: any) => updateSetting("codebaseIndexEnabled", e.target.checked)}>
									<span className="text-sm font-medium">
										{currentSettings.codebaseIndexEnabled ? "Enabled" : "Disabled"}
									</span>
								</VSCodeCheckbox>
							</div>
							{currentSettings.codebaseIndexEnabled && (
								<div className="mt-4 space-y-3 rounded-xl border border-vscode-dropdown-border/60 bg-[rgba(255,255,255,0.018)] p-3">
									<div>
										<div className="flex items-center gap-2">
											<input
												type="checkbox"
												id="workspace-indexing-toggle"
												checked={indexingStatus.workspaceEnabled ?? false}
												onChange={(e) =>
													vscode.postMessage({
														type: "toggleWorkspaceIndexing",
														bool: e.target.checked,
													})
												}
												className="accent-vscode-focusBorder"
											/>
											<label
												htmlFor="workspace-indexing-toggle"
												className="cursor-pointer text-sm text-vscode-foreground">
												{t("settings:codeIndex.workspaceToggleLabel")}
											</label>
										</div>
										{!indexingStatus.workspaceEnabled && (
											<p className="m-0 pt-2 text-xs leading-5 text-vscode-descriptionForeground">
												{t("settings:codeIndex.workspaceDisabledMessage")}
											</p>
										)}
									</div>
									<div className="border-t border-vscode-dropdown-border/50 pt-3">
										<div className="flex items-center gap-2">
											<input
												type="checkbox"
												id="auto-enable-default-toggle"
												checked={indexingStatus.autoEnableDefault ?? true}
												onChange={(e) =>
													vscode.postMessage({
														type: "setAutoEnableDefault",
														bool: e.target.checked,
													})
												}
												className="accent-vscode-focusBorder"
											/>
											<label
												htmlFor="auto-enable-default-toggle"
												className="cursor-pointer text-sm text-vscode-foreground">
												{t("settings:codeIndex.autoEnableDefaultLabel")}
											</label>
										</div>
									</div>
								</div>
							)}
						</div>

						{/* Setup Settings Disclosure */}
						<div ref={setupSectionRef} className="mt-5 scroll-mt-4">
							<button
								onClick={() => setIsSetupSettingsOpen(!isSetupSettingsOpen)}
								className={disclosureButtonClass}
								aria-expanded={isSetupSettingsOpen}>
								<div>
									<div className={sectionLabelClass}>Configuration</div>
									<div className="mt-1 text-[15px] font-semibold tracking-[-0.01em]">
										{t("settings:codeIndex.setupConfigLabel")}
									</div>
								</div>
								<span
									className={`codicon codicon-${isSetupSettingsOpen ? "chevron-down" : "chevron-right"} text-vscode-descriptionForeground`}></span>
							</button>

							{isSetupSettingsOpen && (
								<div className={disclosurePanelClass}>
									<div className="space-y-4">
										{/* Embedder Provider Section */}
										<div className={fieldGroupClass}>
											<label className="text-sm font-medium">
												{t("settings:codeIndex.embedderProviderLabel")}
											</label>
											<Select
												value={currentSettings.codebaseIndexEmbedderProvider}
												onValueChange={(value: EmbedderProvider) => {
													updateSetting("codebaseIndexEmbedderProvider", value)
													// Clear model selection when switching providers
													updateSetting("codebaseIndexEmbedderModelId", "")

													// Auto-populate Region and Profile when switching to Bedrock
													// if the main API provider is also configured for Bedrock
													if (
														value === "bedrock" &&
														apiConfiguration?.apiProvider === "bedrock"
													) {
														// Only populate if currently empty
														if (
															!currentSettings.codebaseIndexBedrockRegion &&
															apiConfiguration.awsRegion
														) {
															updateSetting(
																"codebaseIndexBedrockRegion",
																apiConfiguration.awsRegion,
															)
														}
														if (
															!currentSettings.codebaseIndexBedrockProfile &&
															apiConfiguration.awsProfile
														) {
															updateSetting(
																"codebaseIndexBedrockProfile",
																apiConfiguration.awsProfile,
															)
														}
													}
												}}>
												<SelectTrigger className="w-full">
													<SelectValue />
												</SelectTrigger>
												<SelectContent>
													<SelectItem value="openai">
														{t("settings:codeIndex.openaiProvider")}
													</SelectItem>
													<SelectItem value="ollama">
														{t("settings:codeIndex.ollamaProvider")}
													</SelectItem>
													<SelectItem value="openai-compatible">
														{t("settings:codeIndex.openaiCompatibleProvider")}
													</SelectItem>
													<SelectItem value="gemini">
														{t("settings:codeIndex.geminiProvider")}
													</SelectItem>
													<SelectItem value="mistral">
														{t("settings:codeIndex.mistralProvider")}
													</SelectItem>
													<SelectItem value="vercel-ai-gateway">
														{t("settings:codeIndex.vercelAiGatewayProvider")}
													</SelectItem>
													<SelectItem value="bedrock">
														{t("settings:codeIndex.bedrockProvider")}
													</SelectItem>
													<SelectItem value="openrouter">
														{t("settings:codeIndex.openRouterProvider")}
													</SelectItem>
												</SelectContent>
											</Select>
										</div>

										{/* Provider-specific settings */}
										{currentSettings.codebaseIndexEmbedderProvider === "openai" && (
											<>
												<div className={fieldGroupClass}>
													<label className="text-sm font-medium">
														{t("settings:codeIndex.openAiKeyLabel")}
													</label>
													<VSCodeTextField
														type="password"
														value={currentSettings.codeIndexOpenAiKey || ""}
														onInput={(e: any) =>
															updateSetting("codeIndexOpenAiKey", e.target.value)
														}
														placeholder={t("settings:codeIndex.openAiKeyPlaceholder")}
														className={cn("w-full", {
															"border-red-500": formErrors.codeIndexOpenAiKey,
														})}
													/>
													{formErrors.codeIndexOpenAiKey && (
														<p className="text-xs text-vscode-errorForeground mt-1 mb-0">
															{formErrors.codeIndexOpenAiKey}
														</p>
													)}
												</div>

												<div className={fieldGroupClass}>
													<label className="text-sm font-medium">
														{t("settings:codeIndex.modelLabel")}
													</label>
													<VSCodeDropdown
														value={currentSettings.codebaseIndexEmbedderModelId}
														onChange={(e: any) =>
															updateSetting(
																"codebaseIndexEmbedderModelId",
																e.target.value,
															)
														}
														className={cn("w-full", {
															"border-red-500": formErrors.codebaseIndexEmbedderModelId,
														})}>
														<VSCodeOption value="" className="p-2">
															{t("settings:codeIndex.selectModel")}
														</VSCodeOption>
														{getAvailableModels().map((modelId) => {
															const model =
																codebaseIndexModels?.[
																	currentSettings.codebaseIndexEmbedderProvider as keyof typeof codebaseIndexModels
																]?.[modelId]
															return (
																<VSCodeOption
																	key={modelId}
																	value={modelId}
																	className="p-2">
																	{modelId}{" "}
																	{model
																		? t("settings:codeIndex.modelDimensions", {
																				dimension: model.dimension,
																			})
																		: ""}
																</VSCodeOption>
															)
														})}
													</VSCodeDropdown>
													{formErrors.codebaseIndexEmbedderModelId && (
														<p className="text-xs text-vscode-errorForeground mt-1 mb-0">
															{formErrors.codebaseIndexEmbedderModelId}
														</p>
													)}
												</div>
											</>
										)}

										{currentSettings.codebaseIndexEmbedderProvider === "ollama" && (
											<>
												<div className={fieldGroupClass}>
													<label className="text-sm font-medium">
														{t("settings:codeIndex.ollamaBaseUrlLabel")}
													</label>
													<VSCodeTextField
														value={currentSettings.codebaseIndexEmbedderBaseUrl || ""}
														onInput={(e: any) =>
															updateSetting(
																"codebaseIndexEmbedderBaseUrl",
																e.target.value,
															)
														}
														onBlur={(e: any) => {
															// Set default Ollama URL if field is empty
															if (!e.target.value.trim()) {
																e.target.value = DEFAULT_OLLAMA_URL
																updateSetting(
																	"codebaseIndexEmbedderBaseUrl",
																	DEFAULT_OLLAMA_URL,
																)
															}
														}}
														placeholder={t("settings:codeIndex.ollamaUrlPlaceholder")}
														className={cn("w-full", {
															"border-red-500": formErrors.codebaseIndexEmbedderBaseUrl,
														})}
													/>
													{formErrors.codebaseIndexEmbedderBaseUrl && (
														<p className="text-xs text-vscode-errorForeground mt-1 mb-0">
															{formErrors.codebaseIndexEmbedderBaseUrl}
														</p>
													)}
												</div>

												<div className={fieldGroupClass}>
													<label className="text-sm font-medium">
														{t("settings:codeIndex.modelLabel")}
													</label>
													<VSCodeTextField
														value={currentSettings.codebaseIndexEmbedderModelId || ""}
														onInput={(e: any) =>
															updateSetting(
																"codebaseIndexEmbedderModelId",
																e.target.value,
															)
														}
														placeholder={t("settings:codeIndex.modelPlaceholder")}
														className={cn("w-full", {
															"border-red-500": formErrors.codebaseIndexEmbedderModelId,
														})}
													/>
													{formErrors.codebaseIndexEmbedderModelId && (
														<p className="text-xs text-vscode-errorForeground mt-1 mb-0">
															{formErrors.codebaseIndexEmbedderModelId}
														</p>
													)}
												</div>

												<div className={fieldGroupClass}>
													<label className="text-sm font-medium">
														{t("settings:codeIndex.modelDimensionLabel")}
													</label>
													<VSCodeTextField
														value={
															currentSettings.codebaseIndexEmbedderModelDimension?.toString() ||
															""
														}
														onInput={(e: any) => {
															const value = e.target.value
																? parseInt(e.target.value, 10) || undefined
																: undefined
															updateSetting("codebaseIndexEmbedderModelDimension", value)
														}}
														placeholder={t("settings:codeIndex.modelDimensionPlaceholder")}
														className={cn("w-full", {
															"border-red-500":
																formErrors.codebaseIndexEmbedderModelDimension,
														})}
													/>
													{formErrors.codebaseIndexEmbedderModelDimension && (
														<p className="text-xs text-vscode-errorForeground mt-1 mb-0">
															{formErrors.codebaseIndexEmbedderModelDimension}
														</p>
													)}
												</div>
											</>
										)}

										{currentSettings.codebaseIndexEmbedderProvider === "openai-compatible" && (
											<>
												<div className={fieldGroupClass}>
													<label className="text-sm font-medium">
														{t("settings:codeIndex.openAiCompatibleBaseUrlLabel")}
													</label>
													<VSCodeTextField
														value={
															currentSettings.codebaseIndexOpenAiCompatibleBaseUrl || ""
														}
														onInput={(e: any) =>
															updateSetting(
																"codebaseIndexOpenAiCompatibleBaseUrl",
																e.target.value,
															)
														}
														placeholder={t(
															"settings:codeIndex.openAiCompatibleBaseUrlPlaceholder",
														)}
														className={cn("w-full", {
															"border-red-500":
																formErrors.codebaseIndexOpenAiCompatibleBaseUrl,
														})}
													/>
													{formErrors.codebaseIndexOpenAiCompatibleBaseUrl && (
														<p className="text-xs text-vscode-errorForeground mt-1 mb-0">
															{formErrors.codebaseIndexOpenAiCompatibleBaseUrl}
														</p>
													)}
												</div>

												<div className={fieldGroupClass}>
													<label className="text-sm font-medium">
														{t("settings:codeIndex.openAiCompatibleApiKeyLabel")}
													</label>
													<VSCodeTextField
														type="password"
														value={
															currentSettings.codebaseIndexOpenAiCompatibleApiKey || ""
														}
														onInput={(e: any) =>
															updateSetting(
																"codebaseIndexOpenAiCompatibleApiKey",
																e.target.value,
															)
														}
														placeholder={t(
															"settings:codeIndex.openAiCompatibleApiKeyPlaceholder",
														)}
														className={cn("w-full", {
															"border-red-500":
																formErrors.codebaseIndexOpenAiCompatibleApiKey,
														})}
													/>
													{formErrors.codebaseIndexOpenAiCompatibleApiKey && (
														<p className="text-xs text-vscode-errorForeground mt-1 mb-0">
															{formErrors.codebaseIndexOpenAiCompatibleApiKey}
														</p>
													)}
												</div>

												<div className={fieldGroupClass}>
													<label className="text-sm font-medium">
														{t("settings:codeIndex.modelLabel")}
													</label>
													<VSCodeTextField
														value={currentSettings.codebaseIndexEmbedderModelId || ""}
														onInput={(e: any) =>
															updateSetting(
																"codebaseIndexEmbedderModelId",
																e.target.value,
															)
														}
														placeholder={t("settings:codeIndex.modelPlaceholder")}
														className={cn("w-full", {
															"border-red-500": formErrors.codebaseIndexEmbedderModelId,
														})}
													/>
													{formErrors.codebaseIndexEmbedderModelId && (
														<p className="text-xs text-vscode-errorForeground mt-1 mb-0">
															{formErrors.codebaseIndexEmbedderModelId}
														</p>
													)}
												</div>

												<div className={fieldGroupClass}>
													<label className="text-sm font-medium">
														{t("settings:codeIndex.modelDimensionLabel")}
													</label>
													<VSCodeTextField
														value={
															currentSettings.codebaseIndexEmbedderModelDimension?.toString() ||
															""
														}
														onInput={(e: any) => {
															const value = e.target.value
																? parseInt(e.target.value, 10) || undefined
																: undefined
															updateSetting("codebaseIndexEmbedderModelDimension", value)
														}}
														placeholder={t("settings:codeIndex.modelDimensionPlaceholder")}
														className={cn("w-full", {
															"border-red-500":
																formErrors.codebaseIndexEmbedderModelDimension,
														})}
													/>
													{formErrors.codebaseIndexEmbedderModelDimension && (
														<p className="text-xs text-vscode-errorForeground mt-1 mb-0">
															{formErrors.codebaseIndexEmbedderModelDimension}
														</p>
													)}
												</div>
											</>
										)}

										{currentSettings.codebaseIndexEmbedderProvider === "gemini" && (
											<>
												<div className={fieldGroupClass}>
													<label className="text-sm font-medium">
														{t("settings:codeIndex.geminiApiKeyLabel")}
													</label>
													<VSCodeTextField
														type="password"
														value={currentSettings.codebaseIndexGeminiApiKey || ""}
														onInput={(e: any) =>
															updateSetting("codebaseIndexGeminiApiKey", e.target.value)
														}
														placeholder={t("settings:codeIndex.geminiApiKeyPlaceholder")}
														className={cn("w-full", {
															"border-red-500": formErrors.codebaseIndexGeminiApiKey,
														})}
													/>
													{formErrors.codebaseIndexGeminiApiKey && (
														<p className="text-xs text-vscode-errorForeground mt-1 mb-0">
															{formErrors.codebaseIndexGeminiApiKey}
														</p>
													)}
												</div>

												<div className={fieldGroupClass}>
													<label className="text-sm font-medium">
														{t("settings:codeIndex.modelLabel")}
													</label>
													<VSCodeDropdown
														value={currentSettings.codebaseIndexEmbedderModelId}
														onChange={(e: any) =>
															updateSetting(
																"codebaseIndexEmbedderModelId",
																e.target.value,
															)
														}
														className={cn("w-full", {
															"border-red-500": formErrors.codebaseIndexEmbedderModelId,
														})}>
														<VSCodeOption value="" className="p-2">
															{t("settings:codeIndex.selectModel")}
														</VSCodeOption>
														{getAvailableModels().map((modelId) => {
															const model =
																codebaseIndexModels?.[
																	currentSettings.codebaseIndexEmbedderProvider as keyof typeof codebaseIndexModels
																]?.[modelId]
															return (
																<VSCodeOption
																	key={modelId}
																	value={modelId}
																	className="p-2">
																	{modelId}{" "}
																	{model
																		? t("settings:codeIndex.modelDimensions", {
																				dimension: model.dimension,
																			})
																		: ""}
																</VSCodeOption>
															)
														})}
													</VSCodeDropdown>
													{formErrors.codebaseIndexEmbedderModelId && (
														<p className="text-xs text-vscode-errorForeground mt-1 mb-0">
															{formErrors.codebaseIndexEmbedderModelId}
														</p>
													)}
												</div>
											</>
										)}

										{currentSettings.codebaseIndexEmbedderProvider === "mistral" && (
											<>
												<div className={fieldGroupClass}>
													<label className="text-sm font-medium">
														{t("settings:codeIndex.mistralApiKeyLabel")}
													</label>
													<VSCodeTextField
														type="password"
														value={currentSettings.codebaseIndexMistralApiKey || ""}
														onInput={(e: any) =>
															updateSetting("codebaseIndexMistralApiKey", e.target.value)
														}
														placeholder={t("settings:codeIndex.mistralApiKeyPlaceholder")}
														className={cn("w-full", {
															"border-red-500": formErrors.codebaseIndexMistralApiKey,
														})}
													/>
													{formErrors.codebaseIndexMistralApiKey && (
														<p className="text-xs text-vscode-errorForeground mt-1 mb-0">
															{formErrors.codebaseIndexMistralApiKey}
														</p>
													)}
												</div>

												<div className="space-y-2">
													<label className="text-sm font-medium">
														{t("settings:codeIndex.modelLabel")}
													</label>
													<VSCodeDropdown
														value={currentSettings.codebaseIndexEmbedderModelId}
														onChange={(e: any) =>
															updateSetting(
																"codebaseIndexEmbedderModelId",
																e.target.value,
															)
														}
														className={cn("w-full", {
															"border-red-500": formErrors.codebaseIndexEmbedderModelId,
														})}>
														<VSCodeOption value="" className="p-2">
															{t("settings:codeIndex.selectModel")}
														</VSCodeOption>
														{getAvailableModels().map((modelId) => {
															const model =
																codebaseIndexModels?.[
																	currentSettings.codebaseIndexEmbedderProvider as keyof typeof codebaseIndexModels
																]?.[modelId]
															return (
																<VSCodeOption
																	key={modelId}
																	value={modelId}
																	className="p-2">
																	{modelId}{" "}
																	{model
																		? t("settings:codeIndex.modelDimensions", {
																				dimension: model.dimension,
																			})
																		: ""}
																</VSCodeOption>
															)
														})}
													</VSCodeDropdown>
													{formErrors.codebaseIndexEmbedderModelId && (
														<p className="text-xs text-vscode-errorForeground mt-1 mb-0">
															{formErrors.codebaseIndexEmbedderModelId}
														</p>
													)}
												</div>
											</>
										)}

										{currentSettings.codebaseIndexEmbedderProvider === "vercel-ai-gateway" && (
											<>
												<div className="space-y-2">
													<label className="text-sm font-medium">
														{t("settings:codeIndex.vercelAiGatewayApiKeyLabel")}
													</label>
													<VSCodeTextField
														type="password"
														value={currentSettings.codebaseIndexVercelAiGatewayApiKey || ""}
														onInput={(e: any) =>
															updateSetting(
																"codebaseIndexVercelAiGatewayApiKey",
																e.target.value,
															)
														}
														placeholder={t(
															"settings:codeIndex.vercelAiGatewayApiKeyPlaceholder",
														)}
														className={cn("w-full", {
															"border-red-500":
																formErrors.codebaseIndexVercelAiGatewayApiKey,
														})}
													/>
													{formErrors.codebaseIndexVercelAiGatewayApiKey && (
														<p className="text-xs text-vscode-errorForeground mt-1 mb-0">
															{formErrors.codebaseIndexVercelAiGatewayApiKey}
														</p>
													)}
												</div>

												<div className="space-y-2">
													<label className="text-sm font-medium">
														{t("settings:codeIndex.modelLabel")}
													</label>
													<VSCodeDropdown
														value={currentSettings.codebaseIndexEmbedderModelId}
														onChange={(e: any) =>
															updateSetting(
																"codebaseIndexEmbedderModelId",
																e.target.value,
															)
														}
														className={cn("w-full", {
															"border-red-500": formErrors.codebaseIndexEmbedderModelId,
														})}>
														<VSCodeOption value="" className="p-2">
															{t("settings:codeIndex.selectModel")}
														</VSCodeOption>
														{getAvailableModels().map((modelId) => {
															const model =
																codebaseIndexModels?.[
																	currentSettings.codebaseIndexEmbedderProvider as keyof typeof codebaseIndexModels
																]?.[modelId]
															return (
																<VSCodeOption
																	key={modelId}
																	value={modelId}
																	className="p-2">
																	{modelId}{" "}
																	{model
																		? t("settings:codeIndex.modelDimensions", {
																				dimension: model.dimension,
																			})
																		: ""}
																</VSCodeOption>
															)
														})}
													</VSCodeDropdown>
													{formErrors.codebaseIndexEmbedderModelId && (
														<p className="text-xs text-vscode-errorForeground mt-1 mb-0">
															{formErrors.codebaseIndexEmbedderModelId}
														</p>
													)}
												</div>
											</>
										)}

										{currentSettings.codebaseIndexEmbedderProvider === "bedrock" && (
											<>
												<div className="space-y-2">
													<label className="text-sm font-medium">
														{t("settings:codeIndex.bedrockRegionLabel")}
													</label>
													<VSCodeTextField
														value={currentSettings.codebaseIndexBedrockRegion || ""}
														onInput={(e: any) =>
															updateSetting("codebaseIndexBedrockRegion", e.target.value)
														}
														placeholder={t("settings:codeIndex.bedrockRegionPlaceholder")}
														className={cn("w-full", {
															"border-red-500": formErrors.codebaseIndexBedrockRegion,
														})}
													/>
													{formErrors.codebaseIndexBedrockRegion && (
														<p className="text-xs text-vscode-errorForeground mt-1 mb-0">
															{formErrors.codebaseIndexBedrockRegion}
														</p>
													)}
												</div>

												<div className="space-y-2">
													<label className="text-sm font-medium">
														{t("settings:codeIndex.bedrockProfileLabel")}
														<span className="text-xs text-vscode-descriptionForeground ml-1">
															({t("settings:codeIndex.optional")})
														</span>
													</label>
													<VSCodeTextField
														value={currentSettings.codebaseIndexBedrockProfile || ""}
														onInput={(e: any) =>
															updateSetting("codebaseIndexBedrockProfile", e.target.value)
														}
														placeholder={t("settings:codeIndex.bedrockProfilePlaceholder")}
														className={cn("w-full", {
															"border-red-500": formErrors.codebaseIndexBedrockProfile,
														})}
													/>
													{formErrors.codebaseIndexBedrockProfile && (
														<p className="text-xs text-vscode-errorForeground mt-1 mb-0">
															{formErrors.codebaseIndexBedrockProfile}
														</p>
													)}
													{!formErrors.codebaseIndexBedrockProfile && (
														<p className="text-xs text-vscode-descriptionForeground mt-1 mb-0">
															{t("settings:codeIndex.bedrockProfileDescription")}
														</p>
													)}
												</div>

												<div className="space-y-2">
													<label className="text-sm font-medium">
														{t("settings:codeIndex.modelLabel")}
													</label>
													<VSCodeDropdown
														value={currentSettings.codebaseIndexEmbedderModelId}
														onChange={(e: any) =>
															updateSetting(
																"codebaseIndexEmbedderModelId",
																e.target.value,
															)
														}
														className={cn("w-full", {
															"border-red-500": formErrors.codebaseIndexEmbedderModelId,
														})}>
														<VSCodeOption value="" className="p-2">
															{t("settings:codeIndex.selectModel")}
														</VSCodeOption>
														{getAvailableModels().map((modelId) => {
															const model =
																codebaseIndexModels?.[
																	currentSettings.codebaseIndexEmbedderProvider as keyof typeof codebaseIndexModels
																]?.[modelId]
															return (
																<VSCodeOption
																	key={modelId}
																	value={modelId}
																	className="p-2">
																	{modelId}{" "}
																	{model
																		? t("settings:codeIndex.modelDimensions", {
																				dimension: model.dimension,
																			})
																		: ""}
																</VSCodeOption>
															)
														})}
													</VSCodeDropdown>
													{formErrors.codebaseIndexEmbedderModelId && (
														<p className="text-xs text-vscode-errorForeground mt-1 mb-0">
															{formErrors.codebaseIndexEmbedderModelId}
														</p>
													)}
												</div>
											</>
										)}

										{currentSettings.codebaseIndexEmbedderProvider === "openrouter" && (
											<>
												<div className="space-y-2">
													<label className="text-sm font-medium">
														{t("settings:codeIndex.openRouterApiKeyLabel")}
													</label>
													<VSCodeTextField
														type="password"
														value={currentSettings.codebaseIndexOpenRouterApiKey || ""}
														onInput={(e: any) =>
															updateSetting(
																"codebaseIndexOpenRouterApiKey",
																e.target.value,
															)
														}
														placeholder={t(
															"settings:codeIndex.openRouterApiKeyPlaceholder",
														)}
														className={cn("w-full", {
															"border-red-500": formErrors.codebaseIndexOpenRouterApiKey,
														})}
													/>
													{formErrors.codebaseIndexOpenRouterApiKey && (
														<p className="text-xs text-vscode-errorForeground mt-1 mb-0">
															{formErrors.codebaseIndexOpenRouterApiKey}
														</p>
													)}
												</div>

												<div className="space-y-2">
													<label className="text-sm font-medium">
														{t("settings:codeIndex.modelLabel")}
													</label>
													<VSCodeDropdown
														value={currentSettings.codebaseIndexEmbedderModelId}
														onChange={(e: any) =>
															updateSetting(
																"codebaseIndexEmbedderModelId",
																e.target.value,
															)
														}
														className={cn("w-full", {
															"border-red-500": formErrors.codebaseIndexEmbedderModelId,
														})}>
														<VSCodeOption value="" className="p-2">
															{t("settings:codeIndex.selectModel")}
														</VSCodeOption>
														{getAvailableModels().map((modelId) => {
															const model =
																codebaseIndexModels?.[
																	currentSettings.codebaseIndexEmbedderProvider as keyof typeof codebaseIndexModels
																]?.[modelId]
															return (
																<VSCodeOption
																	key={modelId}
																	value={modelId}
																	className="p-2">
																	{modelId}{" "}
																	{model
																		? t("settings:codeIndex.modelDimensions", {
																				dimension: model.dimension,
																			})
																		: ""}
																</VSCodeOption>
															)
														})}
													</VSCodeDropdown>
													{formErrors.codebaseIndexEmbedderModelId && (
														<p className="text-xs text-vscode-errorForeground mt-1 mb-0">
															{formErrors.codebaseIndexEmbedderModelId}
														</p>
													)}
												</div>

												{/* Provider Routing for OpenRouter */}
												{openRouterEmbeddingProviders &&
													Object.keys(openRouterEmbeddingProviders).length > 0 && (
														<div className={fieldGroupClass}>
															<label className="text-sm font-medium">
																<a
																	href="https://openrouter.ai/docs/features/provider-routing"
																	target="_blank"
																	rel="noopener noreferrer"
																	className="flex items-center gap-1 hover:underline">
																	{t(
																		"settings:codeIndex.openRouterProviderRoutingLabel",
																	)}
																	<span className="codicon codicon-link-external text-xs" />
																</a>
															</label>
															<Select
																value={
																	currentSettings.codebaseIndexOpenRouterSpecificProvider ||
																	OPENROUTER_DEFAULT_PROVIDER_NAME
																}
																onValueChange={(value) =>
																	updateSetting(
																		"codebaseIndexOpenRouterSpecificProvider",
																		value,
																	)
																}>
																<SelectTrigger className="w-full">
																	<SelectValue />
																</SelectTrigger>
																<SelectContent>
																	<SelectItem
																		value={OPENROUTER_DEFAULT_PROVIDER_NAME}>
																		{OPENROUTER_DEFAULT_PROVIDER_NAME}
																	</SelectItem>
																	{Object.entries(openRouterEmbeddingProviders).map(
																		([value, { label }]) => (
																			<SelectItem key={value} value={value}>
																				{label}
																			</SelectItem>
																		),
																	)}
																</SelectContent>
															</Select>
															<p className="text-xs text-vscode-descriptionForeground mt-1 mb-0">
																{t(
																	"settings:codeIndex.openRouterProviderRoutingDescription",
																)}
															</p>
														</div>
													)}
											</>
										)}

										{/* Qdrant Settings */}
										<div className={fieldGroupClass}>
											<label className="text-sm font-medium">
												{t("settings:codeIndex.qdrantUrlLabel")}
											</label>
											<VSCodeTextField
												value={currentSettings.codebaseIndexQdrantUrl || ""}
												onInput={(e: any) =>
													updateSetting("codebaseIndexQdrantUrl", e.target.value)
												}
												onBlur={(e: any) => {
													// Set default Qdrant URL if field is empty
													if (!e.target.value.trim()) {
														currentSettings.codebaseIndexQdrantUrl = DEFAULT_QDRANT_URL
														updateSetting("codebaseIndexQdrantUrl", DEFAULT_QDRANT_URL)
													}
												}}
												placeholder={t("settings:codeIndex.qdrantUrlPlaceholder")}
												className={cn("w-full", {
													"border-red-500": formErrors.codebaseIndexQdrantUrl,
												})}
											/>
											{formErrors.codebaseIndexQdrantUrl && (
												<p className="text-xs text-vscode-errorForeground mt-1 mb-0">
													{formErrors.codebaseIndexQdrantUrl}
												</p>
											)}
										</div>

										<div className={fieldGroupClass}>
											<label className="text-sm font-medium">
												{t("settings:codeIndex.qdrantApiKeyLabel")}
											</label>
											<VSCodeTextField
												type="password"
												value={currentSettings.codeIndexQdrantApiKey || ""}
												onInput={(e: any) =>
													updateSetting("codeIndexQdrantApiKey", e.target.value)
												}
												placeholder={t("settings:codeIndex.qdrantApiKeyPlaceholder")}
												className={cn("w-full", {
													"border-red-500": formErrors.codeIndexQdrantApiKey,
												})}
											/>
											{formErrors.codeIndexQdrantApiKey && (
												<p className="text-xs text-vscode-errorForeground mt-1 mb-0">
													{formErrors.codeIndexQdrantApiKey}
												</p>
											)}
										</div>
									</div>
								</div>
							)}
						</div>

						{/* Advanced Settings Disclosure */}
						<div ref={advancedSectionRef} className="mt-5 scroll-mt-4">
							<button
								onClick={() => setIsAdvancedSettingsOpen(!isAdvancedSettingsOpen)}
								className={disclosureButtonClass}
								aria-expanded={isAdvancedSettingsOpen}>
								<div>
									<div className={sectionLabelClass}>Tuning</div>
									<div className="mt-1 text-[15px] font-semibold tracking-[-0.01em]">
										{t("settings:codeIndex.advancedConfigLabel")}
									</div>
								</div>
								<span
									className={`codicon codicon-${isAdvancedSettingsOpen ? "chevron-down" : "chevron-right"} text-vscode-descriptionForeground`}></span>
							</button>

							{isAdvancedSettingsOpen && (
								<div className={disclosurePanelClass}>
									<div className="space-y-4">
										{/* Search Score Threshold Slider */}
										<div className={fieldGroupClass}>
											<div className="flex items-center gap-2">
												<label className="text-sm font-medium">
													{t("settings:codeIndex.searchMinScoreLabel")}
												</label>
												<StandardTooltip
													content={t("settings:codeIndex.searchMinScoreDescription")}>
													<span className="codicon codicon-info text-xs text-vscode-descriptionForeground cursor-help" />
												</StandardTooltip>
											</div>
											<div className="flex items-center gap-2">
												<Slider
													min={CODEBASE_INDEX_DEFAULTS.MIN_SEARCH_SCORE}
													max={CODEBASE_INDEX_DEFAULTS.MAX_SEARCH_SCORE}
													step={CODEBASE_INDEX_DEFAULTS.SEARCH_SCORE_STEP}
													value={[
														currentSettings.codebaseIndexSearchMinScore ??
															CODEBASE_INDEX_DEFAULTS.DEFAULT_SEARCH_MIN_SCORE,
													]}
													onValueChange={(values) =>
														updateSetting("codebaseIndexSearchMinScore", values[0])
													}
													className="flex-1 min-w-[80px]"
													data-testid="search-min-score-slider"
												/>
												<span className="w-12 text-center">
													{(
														currentSettings.codebaseIndexSearchMinScore ??
														CODEBASE_INDEX_DEFAULTS.DEFAULT_SEARCH_MIN_SCORE
													).toFixed(2)}
												</span>
												<VSCodeButton
													appearance="icon"
													title={t("settings:codeIndex.resetToDefault")}
													onClick={() =>
														updateSetting(
															"codebaseIndexSearchMinScore",
															CODEBASE_INDEX_DEFAULTS.DEFAULT_SEARCH_MIN_SCORE,
														)
													}>
													<span className="codicon codicon-discard" />
												</VSCodeButton>
											</div>
										</div>

										{/* Maximum Search Results Slider */}
										<div className={fieldGroupClass}>
											<div className="flex items-center gap-2">
												<label className="text-sm font-medium">
													{t("settings:codeIndex.searchMaxResultsLabel")}
												</label>
												<StandardTooltip
													content={t("settings:codeIndex.searchMaxResultsDescription")}>
													<span className="codicon codicon-info text-xs text-vscode-descriptionForeground cursor-help" />
												</StandardTooltip>
											</div>
											<div className="flex items-center gap-2">
												<Slider
													min={CODEBASE_INDEX_DEFAULTS.MIN_SEARCH_RESULTS}
													max={CODEBASE_INDEX_DEFAULTS.MAX_SEARCH_RESULTS}
													step={CODEBASE_INDEX_DEFAULTS.SEARCH_RESULTS_STEP}
													value={[
														currentSettings.codebaseIndexSearchMaxResults ??
															CODEBASE_INDEX_DEFAULTS.DEFAULT_SEARCH_RESULTS,
													]}
													onValueChange={(values) =>
														updateSetting("codebaseIndexSearchMaxResults", values[0])
													}
													className="flex-1 min-w-[80px]"
													data-testid="search-max-results-slider"
												/>
												<span className="w-12 text-center">
													{currentSettings.codebaseIndexSearchMaxResults ??
														CODEBASE_INDEX_DEFAULTS.DEFAULT_SEARCH_RESULTS}
												</span>
												<VSCodeButton
													appearance="icon"
													title={t("settings:codeIndex.resetToDefault")}
													onClick={() =>
														updateSetting(
															"codebaseIndexSearchMaxResults",
															CODEBASE_INDEX_DEFAULTS.DEFAULT_SEARCH_RESULTS,
														)
													}>
													<span className="codicon codicon-discard" />
												</VSCodeButton>
											</div>
										</div>

										<div className={fieldGroupClass}>
											<div className="flex items-center gap-2">
												<label className="text-sm font-medium">
													{t("settings:codeIndex.maxFilesLabel")}
												</label>
												<StandardTooltip content={t("settings:codeIndex.maxFilesDescription")}>
													<span className="codicon codicon-info text-xs text-vscode-descriptionForeground cursor-help" />
												</StandardTooltip>
											</div>
											<VSCodeTextField
												value={currentSettings.codebaseIndexMaxFiles?.toString() || ""}
												onInput={(e: any) =>
													updateSetting(
														"codebaseIndexMaxFiles",
														e.target.value
															? parseInt(e.target.value, 10) || undefined
															: undefined,
													)
												}
												placeholder="100000"
												className="w-full"
											/>
										</div>

										<div className={fieldGroupClass}>
											<div className="flex items-center gap-2">
												<label className="text-sm font-medium">
													{t("settings:codeIndex.embeddingBatchSizeLabel")}
												</label>
												<StandardTooltip
													content={t("settings:codeIndex.embeddingBatchSizeDescription")}>
													<span className="codicon codicon-info text-xs text-vscode-descriptionForeground cursor-help" />
												</StandardTooltip>
											</div>
											<VSCodeTextField
												value={
													currentSettings.codebaseIndexEmbeddingBatchSize?.toString() || ""
												}
												onInput={(e: any) =>
													updateSetting(
														"codebaseIndexEmbeddingBatchSize",
														e.target.value
															? parseInt(e.target.value, 10) || undefined
															: undefined,
													)
												}
												placeholder="60"
												className="w-full"
											/>
										</div>

										<div className={fieldGroupClass}>
											<div className="flex items-center gap-2">
												<label className="text-sm font-medium">
													{t("settings:codeIndex.fileSearchIndexLimitLabel")}
												</label>
												<StandardTooltip
													content={t("settings:codeIndex.fileSearchIndexLimitDescription")}>
													<span className="codicon codicon-info text-xs text-vscode-descriptionForeground cursor-help" />
												</StandardTooltip>
											</div>
											<VSCodeTextField
												value={
													currentSettings.maximumIndexedFilesForFileSearch?.toString() || ""
												}
												onInput={(e: any) =>
													updateSetting(
														"maximumIndexedFilesForFileSearch",
														e.target.value
															? parseInt(e.target.value, 10) || undefined
															: undefined,
													)
												}
												placeholder="10000"
												className="w-full"
											/>
										</div>

										<div className="space-y-2 rounded-xl border border-vscode-dropdown-border/60 bg-[rgba(255,255,255,0.018)] p-3">
											<div className="flex items-start gap-2">
												<input
													type="checkbox"
													id="respect-gitignore-toggle"
													checked={currentSettings.codebaseIndexRespectGitIgnore}
													onChange={(e) =>
														updateSetting("codebaseIndexRespectGitIgnore", e.target.checked)
													}
													className="mt-0.5 accent-vscode-focusBorder"
												/>
												<div className="space-y-1">
													<label
														htmlFor="respect-gitignore-toggle"
														className="cursor-pointer text-sm text-vscode-foreground">
														{t("settings:codeIndex.respectGitIgnoreLabel")}
													</label>
													<p className="m-0 text-xs leading-5 text-vscode-descriptionForeground">
														{t("settings:codeIndex.respectGitIgnoreDescription")}
													</p>
													<p className="m-0 text-xs leading-5 text-vscode-descriptionForeground/90">
														{t("settings:codeIndex.rooIgnoreAlwaysAppliesNote")}
													</p>
												</div>
											</div>
											{!currentSettings.codebaseIndexRespectGitIgnore && (
												<div className="flex items-start gap-2 rounded-xl border border-yellow-500/35 bg-yellow-500/10 px-3 py-2 text-xs leading-5 text-vscode-descriptionForeground">
													<AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-yellow-500" />
													<span>{t("settings:codeIndex.respectGitIgnoreWarning")}</span>
												</div>
											)}
										</div>

										<div className={fieldGroupClass}>
											<div className="flex items-start gap-2">
												<input
													type="checkbox"
													id="code-index-debug-logging-toggle"
													checked={currentSettings.codebaseIndexDebugLogging}
													onChange={(e) =>
														updateSetting("codebaseIndexDebugLogging", e.target.checked)
													}
													className="mt-0.5 accent-vscode-focusBorder"
												/>
												<div className="space-y-1">
													<label
														htmlFor="code-index-debug-logging-toggle"
														className="cursor-pointer text-sm text-vscode-foreground">
														{t("settings:codeIndex.debugLoggingLabel")}
													</label>
													<p className="m-0 text-xs leading-5 text-vscode-descriptionForeground">
														{t("settings:codeIndex.debugLoggingDescription")}
													</p>
												</div>
											</div>
										</div>
									</div>
								</div>
							)}
						</div>
					</div>

					{/* Sticky Action Footer */}
					<div className="flex-shrink-0 border-t border-vscode-dropdown-border/80 bg-[linear-gradient(180deg,rgba(255,255,255,0.03),rgba(255,255,255,0.012))] px-5 py-4 backdrop-blur-md">
						<div className="flex flex-wrap items-center justify-between gap-3">
							<div className="flex flex-wrap gap-2">
								{shouldShowStartAction && (
									<Button
										variant="outline"
										className={footerSecondaryButtonClass}
										onClick={() => vscode.postMessage({ type: "startIndexing" })}
										disabled={saveStatus === "saving" || hasUnsavedChanges}>
										{t("settings:codeIndex.startIndexingButton")}
									</Button>
								)}

								{shouldShowRefreshAction && (
									<Button
										variant="outline"
										className={footerSecondaryButtonClass}
										onClick={() => vscode.postMessage({ type: "startIndexing" })}
										disabled={saveStatus === "saving" || hasUnsavedChanges}>
										{isCurrentStandby
											? t("settings:codeIndex.refreshIndexButton")
											: t("settings:codeIndex.reindexButton")}
									</Button>
								)}

								{currentSettings.codebaseIndexEnabled && indexingStatus.systemStatus === "Indexing" && (
									<Button
										variant="destructive"
										className={footerDestructiveButtonClass}
										onClick={() => vscode.postMessage({ type: "stopIndexing" })}>
										{t("settings:codeIndex.stopIndexingButton")}
									</Button>
								)}

								{currentSettings.codebaseIndexEnabled && indexingStatus.systemStatus === "Stopping" && (
									<Button variant="destructive" className={footerDestructiveButtonClass} disabled>
										{t("settings:codeIndex.stoppingButton")}
									</Button>
								)}

								{currentSettings.codebaseIndexEnabled &&
									(indexingStatus.systemStatus === "Indexed" ||
										isCurrentStandby ||
										indexingStatus.systemStatus === "Error") && (
										<AlertDialog>
											<AlertDialogTrigger asChild>
												<Button variant="secondary" className={footerDestructiveButtonClass}>
													{t("settings:codeIndex.clearIndexDataButton")}
												</Button>
											</AlertDialogTrigger>
											<AlertDialogContent>
												<AlertDialogHeader>
													<AlertDialogTitle>
														{t("settings:codeIndex.clearDataDialog.title")}
													</AlertDialogTitle>
													<AlertDialogDescription>
														{t("settings:codeIndex.clearDataDialog.description")}
													</AlertDialogDescription>
												</AlertDialogHeader>
												<AlertDialogFooter>
													<AlertDialogCancel>
														{t("settings:codeIndex.clearDataDialog.cancelButton")}
													</AlertDialogCancel>
													<AlertDialogAction
														onClick={() => vscode.postMessage({ type: "clearIndexData" })}>
														{t("settings:codeIndex.clearDataDialog.confirmButton")}
													</AlertDialogAction>
												</AlertDialogFooter>
											</AlertDialogContent>
										</AlertDialog>
									)}
							</div>

							{hasUnsavedChanges || saveStatus === "saving" ? (
								<Button
									variant="primary"
									className={footerPrimaryButtonClass}
									onClick={handleSaveSettings}
									disabled={!hasUnsavedChanges || saveStatus === "saving"}>
									{saveStatus === "saving"
										? t("settings:codeIndex.saving")
										: t("settings:codeIndex.saveSettings")}
								</Button>
							) : (
								<Button variant="outline" className={footerDisabledButtonClass} disabled>
									{t("settings:codeIndex.saveSettings")}
								</Button>
							)}
						</div>

						{/* Save Status Messages */}
						{saveStatus === "error" && (
							<div className="mt-2">
								<span className="text-sm text-vscode-errorForeground block">
									{saveError || t("settings:codeIndex.saveError")}
								</span>
							</div>
						)}
					</div>
				</PopoverContent>
			</Popover>

			{/* Discard Changes Dialog */}
			<AlertDialog open={isDiscardDialogShow} onOpenChange={setDiscardDialogShow}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle className="flex items-center gap-2">
							<AlertTriangle className="w-5 h-5 text-yellow-500" />
							{t("settings:unsavedChangesDialog.title")}
						</AlertDialogTitle>
						<AlertDialogDescription>
							{t("settings:unsavedChangesDialog.description")}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel onClick={() => onConfirmDialogResult(false)}>
							{t("settings:unsavedChangesDialog.cancelButton")}
						</AlertDialogCancel>
						<AlertDialogAction onClick={() => onConfirmDialogResult(true)}>
							{t("settings:unsavedChangesDialog.discardButton")}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	)
}
