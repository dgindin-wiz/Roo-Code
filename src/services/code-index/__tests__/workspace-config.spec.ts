import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("vscode", () => {
	const workspaceFolders = [
		{
			uri: {
				fsPath: "/workspace/a",
				toString: () => "file:///workspace/a",
			},
			name: "a",
			index: 0,
		},
		{
			uri: {
				fsPath: "/workspace/b",
				toString: () => "file:///workspace/b",
			},
			name: "b",
			index: 1,
		},
	]

	return {
		Uri: {
			file: (filePath: string) => ({
				fsPath: filePath,
				toString: () => `file://${filePath}`,
			}),
		},
		workspace: {
			workspaceFolders,
			getWorkspaceFolder: vi.fn((uri: { fsPath: string }) =>
				workspaceFolders.find(
					(folder) => uri.fsPath === folder.uri.fsPath || uri.fsPath.startsWith(`${folder.uri.fsPath}/`),
				),
			),
		},
	}
})

import {
	ensureWorkspaceCodeIndexConfig,
	getWorkspaceCodeIndexConfig,
	getWorkspaceCodeIndexConfigKey,
	setWorkspaceCodeIndexConfig,
} from "../workspace-config"

describe("workspace-config", () => {
	let store: Record<string, unknown>
	let context: any

	beforeEach(() => {
		store = {}
		context = {
			workspaceState: {
				get: vi.fn((key: string, defaultValue?: unknown) => store[key] ?? defaultValue),
				update: vi.fn(async (key: string, value: unknown) => {
					store[key] = value
				}),
			},
		}
	})

	it("migrates the legacy config into the current workspace on first access", async () => {
		const legacyConfig = {
			codebaseIndexEnabled: true,
			codebaseIndexQdrantUrl: "http://legacy-qdrant",
		}

		await ensureWorkspaceCodeIndexConfig(context, "/workspace/a", legacyConfig)

		expect(getWorkspaceCodeIndexConfig(context, "/workspace/a")).toEqual(legacyConfig)
		expect(store[getWorkspaceCodeIndexConfigKey("/workspace/a")]).toEqual(legacyConfig)
	})

	it("stores configs independently for multiple workspaces in one window", async () => {
		await setWorkspaceCodeIndexConfig(context, "/workspace/a", {
			codebaseIndexEnabled: true,
			codebaseIndexQdrantUrl: "http://workspace-a",
		})
		await setWorkspaceCodeIndexConfig(context, "/workspace/b", {
			codebaseIndexEnabled: false,
			codebaseIndexQdrantUrl: "http://workspace-b",
		})

		expect(getWorkspaceCodeIndexConfig(context, "/workspace/a")).toEqual({
			codebaseIndexEnabled: true,
			codebaseIndexQdrantUrl: "http://workspace-a",
		})
		expect(getWorkspaceCodeIndexConfig(context, "/workspace/b")).toEqual({
			codebaseIndexEnabled: false,
			codebaseIndexQdrantUrl: "http://workspace-b",
		})
	})
})
