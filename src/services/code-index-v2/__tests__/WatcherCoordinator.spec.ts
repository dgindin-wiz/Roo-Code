import { beforeEach, describe, expect, it, vi } from "vitest"
import { WatcherCoordinator } from "../watcher/WatcherCoordinator"

const { watcherMock } = vi.hoisted(() => ({
	watcherMock: {
		onDidCreate: vi.fn(),
		onDidChange: vi.fn(),
		onDidDelete: vi.fn(),
		dispose: vi.fn(),
	},
}))

vi.mock("vscode", () => ({
	workspace: {
		createFileSystemWatcher: vi.fn().mockReturnValue(watcherMock),
	},
	RelativePattern: vi.fn().mockImplementation((base: string, pattern: string) => ({ base, pattern })),
}))

vi.mock("../logging/IndexDebugLoggerV2", () => ({
	IndexDebugLoggerV2: {
		log: vi.fn(),
	},
}))

describe("WatcherCoordinator", () => {
	beforeEach(() => {
		vi.useFakeTimers()
		vi.clearAllMocks()
	})

	it("coalesces watcher events into a single debounced targeted update", async () => {
		let onCreate: ((uri: { fsPath: string }) => void) | undefined
		let onChange: ((uri: { fsPath: string }) => void) | undefined
		let onDelete: ((uri: { fsPath: string }) => void) | undefined

		watcherMock.onDidCreate.mockImplementation((handler: (uri: { fsPath: string }) => void) => {
			onCreate = handler
			return { dispose: vi.fn() }
		})
		watcherMock.onDidChange.mockImplementation((handler: (uri: { fsPath: string }) => void) => {
			onChange = handler
			return { dispose: vi.fn() }
		})
		watcherMock.onDidDelete.mockImplementation((handler: (uri: { fsPath: string }) => void) => {
			onDelete = handler
			return { dispose: vi.fn() }
		})

		const metadataStore = {
			recordWatchEvent: vi.fn().mockResolvedValue(undefined),
		} as any
		const workspaceAdapter = {
			isCandidateFile: vi.fn().mockReturnValue(true),
		} as any
		const onPathsChanged = vi.fn().mockResolvedValue(undefined)

		const coordinator = new WatcherCoordinator("/workspace", metadataStore, workspaceAdapter, onPathsChanged)
		await coordinator.initialize()

		await onCreate?.({ fsPath: "/workspace/src/a.ts" })
		await onChange?.({ fsPath: "/workspace/src/a.ts" })
		await onDelete?.({ fsPath: "/workspace/src/b.ts" })

		expect(metadataStore.recordWatchEvent).toHaveBeenCalledTimes(3)
		expect(onPathsChanged).not.toHaveBeenCalled()

		await vi.advanceTimersByTimeAsync(500)

		expect(onPathsChanged).toHaveBeenCalledTimes(1)
		expect(onPathsChanged).toHaveBeenCalledWith(
			expect.arrayContaining(["/workspace/src/a.ts", "/workspace/src/b.ts"]),
			"watcher",
		)

		coordinator.dispose()
	})

	it("ignores non-candidate create and change events before they enter the queue", async () => {
		let onCreate: ((uri: { fsPath: string }) => void) | undefined
		let onChange: ((uri: { fsPath: string }) => void) | undefined
		let onDelete: ((uri: { fsPath: string }) => void) | undefined

		watcherMock.onDidCreate.mockImplementation((handler: (uri: { fsPath: string }) => void) => {
			onCreate = handler
			return { dispose: vi.fn() }
		})
		watcherMock.onDidChange.mockImplementation((handler: (uri: { fsPath: string }) => void) => {
			onChange = handler
			return { dispose: vi.fn() }
		})
		watcherMock.onDidDelete.mockImplementation((handler: (uri: { fsPath: string }) => void) => {
			onDelete = handler
			return { dispose: vi.fn() }
		})

		const metadataStore = {
			recordWatchEvent: vi.fn().mockResolvedValue(undefined),
		} as any
		const workspaceAdapter = {
			isCandidateFile: vi
				.fn()
				.mockImplementation(
					(filePath: string) => !filePath.includes("/dist/") && !filePath.includes("/.vite/"),
				),
		} as any
		const onPathsChanged = vi.fn().mockResolvedValue(undefined)

		const coordinator = new WatcherCoordinator("/workspace", metadataStore, workspaceAdapter, onPathsChanged)
		await coordinator.initialize()

		await onCreate?.({ fsPath: "/workspace/src/dist/generated.js" })
		await onChange?.({ fsPath: "/workspace/webview-ui/node_modules/.vite/vitest/results.json" })
		await onDelete?.({ fsPath: "/workspace/src/real-file.ts" })

		expect(metadataStore.recordWatchEvent).toHaveBeenCalledTimes(1)
		expect(metadataStore.recordWatchEvent).toHaveBeenCalledWith("src/real-file.ts", "delete")

		await vi.advanceTimersByTimeAsync(500)

		expect(onPathsChanged).toHaveBeenCalledTimes(1)
		expect(onPathsChanged).toHaveBeenCalledWith(["/workspace/src/real-file.ts"], "watcher")

		coordinator.dispose()
	})
})
