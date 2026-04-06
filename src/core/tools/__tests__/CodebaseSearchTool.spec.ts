import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ToolUse } from "../../../shared/tools"

const mockSearchIndex = vi.fn()
const mockGetInstance = vi.fn()

vi.mock("vscode", () => ({
	workspace: {
		asRelativePath: vi.fn((filePath: string) => filePath.replace(/^\/workspace\//, "")),
	},
}))

vi.mock("../../../services/code-index/manager", () => ({
	CodeIndexManager: {
		getInstance: (...args: unknown[]) => mockGetInstance(...args),
	},
}))

import { codebaseSearchTool } from "../CodebaseSearchTool"

describe("codebaseSearchTool", () => {
	let mockTask: any
	let mockCallbacks: any

	beforeEach(() => {
		vi.clearAllMocks()

		mockGetInstance.mockReturnValue({
			isFeatureEnabled: true,
			isFeatureConfigured: true,
			searchIndex: mockSearchIndex,
		})

		mockTask = {
			cwd: "/workspace",
			consecutiveMistakeCount: 0,
			didToolFailInCurrentTurn: false,
			sayAndCreateMissingParamError: vi.fn().mockResolvedValue("Missing parameter error"),
			say: vi.fn().mockResolvedValue(undefined),
			providerRef: {
				deref: vi.fn().mockReturnValue({
					context: {},
				}),
			},
		}

		mockCallbacks = {
			askApproval: vi.fn().mockResolvedValue(true),
			handleError: vi.fn(),
			pushToolResult: vi.fn(),
		}
	})

	it("preserves essential model-facing search result fields in tool output", async () => {
		mockSearchIndex.mockResolvedValue([
			{
				id: "point-1",
				score: 0.91,
				rerankScore: 1.12,
				matchReasons: ["exact hinted symbol match", "lexical match"],
				payload: {
					filePath: "/workspace/src/auth/validate.ts",
					chunkFingerprint: "chunk-fp-1",
					startLine: 10,
					endLine: 18,
					codeChunk: "export function validateToken(token: string) {\n\treturn token.length > 0\n}",
					language: "ts",
					chunkKind: "function",
					symbolName: "validateToken",
					symbolQualifiedName: "Auth.validateToken",
					parentSymbolName: "Auth",
					summary: "ts function validateToken in Auth at src/auth/validate.ts:10-18",
				},
			},
		])

		const block: ToolUse<"codebase_search"> = {
			type: "tool_use",
			name: "codebase_search",
			params: {},
			partial: false,
			nativeArgs: {
				query: "validateToken",
				path: "src/auth",
			},
		}

		await codebaseSearchTool.handle(mockTask, block, mockCallbacks)

		expect(mockSearchIndex).toHaveBeenCalledWith("validateToken", "src/auth")
		expect(mockTask.say).toHaveBeenCalledWith(
			"codebase_search_result",
			expect.stringContaining('"filePath":"src/auth/validate.ts"'),
		)
		expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith(
			expect.stringContaining("File path: src/auth/validate.ts"),
		)
		expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Lines: 10-18"))
		expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith(
			expect.stringContaining("Code Chunk: export function validateToken(token: string) {"),
		)
		expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("return token.length > 0"))
	})
})
