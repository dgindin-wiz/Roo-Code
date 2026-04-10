import { StrictMode, startTransition, useCallback, useEffect, useRef, useState } from "react"
import { createRoot } from "react-dom/client"

import "./index.css"
import "../node_modules/@vscode/codicons/dist/codicon.css"
import { vscode } from "./utils/vscode"

type AppComponent = typeof import("./App").default

const root = createRoot(document.getElementById("root")!)

const loadAppModule = async (): Promise<AppComponent> => {
	const { default: App } = await import("./App")
	return App
}

const postBootMarker = (marker: string) => {
	vscode.postMessage({
		type: "webviewBootMarker" as any,
		text: marker,
	})
}

const BootShell = () => {
	const [LoadedApp, setLoadedApp] = useState<AppComponent | null>(null)
	const [isLoading, setIsLoading] = useState(false)
	const [loadError, setLoadError] = useState<string | null>(null)
	const hasAutoLoadAttemptedRef = useRef(false)

	useEffect(() => {
		postBootMarker("boot-shell-mounted")
	}, [])

	const handleLoad = useCallback(async () => {
		if (LoadedApp || isLoading) {
			return
		}

		setIsLoading(true)
		setLoadError(null)

		try {
			const App = await loadAppModule()
			startTransition(() => setLoadedApp(() => App))
		} catch (error) {
			console.error("Failed to load Roo Code webview:", error)
			setLoadError(error instanceof Error ? error.message : "Unknown load failure")
			setIsLoading(false)
		}
	}, [LoadedApp, isLoading])

	useEffect(() => {
		if (hasAutoLoadAttemptedRef.current) {
			return
		}
		hasAutoLoadAttemptedRef.current = true
		void handleLoad()
	}, [handleLoad])

	if (LoadedApp) {
		return <LoadedApp />
	}

	return (
		<div
			style={{
				display: "flex",
				minHeight: "100vh",
				alignItems: "center",
				justifyContent: "center",
				padding: "24px",
				background: "var(--vscode-sideBar-background)",
				color: "var(--vscode-foreground)",
			}}>
			<div
				style={{
					width: "100%",
					maxWidth: "360px",
					border: "1px solid var(--vscode-editorWidget-border)",
					borderRadius: "12px",
					padding: "20px",
					background: "var(--vscode-editor-background)",
					boxShadow: "0 18px 36px rgba(0, 0, 0, 0.18)",
				}}>
				<h1 style={{ margin: "0 0 8px", fontSize: "18px", fontWeight: 600 }}>Roo Code</h1>
				<p style={{ margin: "0 0 16px", lineHeight: 1.5, opacity: 0.85 }}>Loading the workspace assistant.</p>
				{loadError && (
					<p style={{ margin: "0 0 16px", lineHeight: 1.5, color: "var(--vscode-errorForeground)" }}>
						Failed to load the UI. You can retry without reloading the whole sidebar.
					</p>
				)}
				<button
					onClick={() => void handleLoad()}
					disabled={isLoading}
					style={{
						width: "100%",
						border: "none",
						borderRadius: "8px",
						padding: "10px 14px",
						font: "inherit",
						fontWeight: 600,
						cursor: isLoading ? "progress" : "pointer",
						background: "var(--vscode-button-background)",
						color: "var(--vscode-button-foreground)",
					}}>
					{isLoading ? "Loading Roo Code..." : loadError ? "Retry loading Roo Code" : "Loading Roo Code..."}
				</button>
			</div>
		</div>
	)
}

root.render(
	<StrictMode>
		<BootShell />
	</StrictMode>,
)
