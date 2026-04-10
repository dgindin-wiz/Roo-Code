import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("vscode", () => ({
	workspace: {
		createFileSystemWatcher: vi.fn().mockReturnValue({
			onDidCreate: vi.fn().mockReturnValue({ dispose: vi.fn() }),
			onDidChange: vi.fn().mockReturnValue({ dispose: vi.fn() }),
			onDidDelete: vi.fn().mockReturnValue({ dispose: vi.fn() }),
			dispose: vi.fn(),
		}),
		getConfiguration: vi.fn().mockReturnValue({
			get: vi.fn((_key: string, defaultValue: unknown) => defaultValue),
		}),
		fs: {
			stat: vi.fn(async (uri: { fsPath: string }) => {
				const stat = await fs.stat(uri.fsPath)
				return {
					type: stat.isDirectory() ? 2 : 1,
					ctime: stat.ctimeMs,
					mtime: stat.mtimeMs,
					size: stat.size,
				}
			}),
			readFile: vi.fn(async (uri: { fsPath: string }) => {
				return await fs.readFile(uri.fsPath)
			}),
		},
	},
	RelativePattern: vi.fn().mockImplementation((base: string, pattern: string) => ({ base, pattern })),
	Uri: {
		file: (filePath: string) => ({ fsPath: filePath }),
	},
}))

vi.mock("../../../core/ignore/RooIgnoreController", () => ({
	RooIgnoreController: class MockRooIgnoreController {
		private rooIgnoreEntries: string[] = []

		constructor(private readonly cwd: string) {}

		async initialize(): Promise<void> {
			try {
				const content = await fs.readFile(path.join(this.cwd, ".rooignore"), "utf8")
				this.rooIgnoreEntries = content
					.split(/\r?\n/)
					.map((entry) => entry.trim())
					.filter((entry) => entry.length > 0)
			} catch {
				this.rooIgnoreEntries = []
			}
		}

		validateAccess(filePath: string): boolean {
			const relativePath = path.relative(this.cwd, filePath).replace(/\\/g, "/")
			return !this.rooIgnoreEntries.includes(relativePath)
		}
	},
}))

import { VsCodeWorkspaceAdapter } from "../adapters/VsCodeWorkspaceAdapter"

describe("VsCodeWorkspaceAdapter", () => {
	let workspaceRoot: string

	beforeEach(async () => {
		workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "roo-code-index-v2-adapter-"))
	})

	afterEach(async () => {
		await fs.rm(workspaceRoot, { recursive: true, force: true })
	})

	it("honors nested .gitignore rules during discovery", async () => {
		await fs.mkdir(path.join(workspaceRoot, "packages", "child"), { recursive: true })
		await fs.writeFile(path.join(workspaceRoot, "packages", ".gitignore"), "child/**\n!child/keep.ts\n", "utf8")
		await fs.writeFile(
			path.join(workspaceRoot, "packages", "child", "keep.ts"),
			"export const keep = true\n",
			"utf8",
		)
		await fs.writeFile(
			path.join(workspaceRoot, "packages", "child", "skip.ts"),
			"export const skip = true\n",
			"utf8",
		)

		const adapter = new VsCodeWorkspaceAdapter(workspaceRoot, { respectGitIgnore: true })
		await adapter.initialize()

		const discovered: string[] = []
		await adapter.enumerateCandidateFiles((filePath) => {
			discovered.push(path.relative(workspaceRoot, filePath).replace(/\\/g, "/"))
		})

		expect(discovered).toContain("packages/child/keep.ts")
		expect(discovered).not.toContain("packages/child/skip.ts")
	})

	it("excludes generated build directories by default", async () => {
		await fs.mkdir(path.join(workspaceRoot, "src", "webview-ui", "build", "assets"), { recursive: true })
		await fs.writeFile(
			path.join(workspaceRoot, "src", "webview-ui", "build", "assets", "index.ts"),
			"export const generated = true\n",
			"utf8",
		)

		const adapter = new VsCodeWorkspaceAdapter(workspaceRoot, { respectGitIgnore: false })
		await adapter.initialize()

		const discovered: string[] = []
		await adapter.enumerateCandidateFiles((filePath) => {
			discovered.push(path.relative(workspaceRoot, filePath).replace(/\\/g, "/"))
		})

		expect(discovered).not.toContain("src/webview-ui/build/assets/index.ts")
	})

	it("allows default-ignored generated paths back in when explicitly enabled", async () => {
		await fs.mkdir(path.join(workspaceRoot, "src", "dist"), { recursive: true })
		await fs.writeFile(
			path.join(workspaceRoot, "src", "dist", "generated.ts"),
			"export const generated = true\n",
			"utf8",
		)

		const adapter = new VsCodeWorkspaceAdapter(workspaceRoot, {
			respectGitIgnore: false,
			includeDefaultIgnoredGeneratedPaths: true,
		})
		await adapter.initialize()

		const discovered: string[] = []
		await adapter.enumerateCandidateFiles((filePath) => {
			discovered.push(path.relative(workspaceRoot, filePath).replace(/\\/g, "/"))
		})

		expect(discovered).toContain("src/dist/generated.ts")
	})

	it("keeps root .rooignore enforcement independent from gitignore behavior", async () => {
		await fs.writeFile(path.join(workspaceRoot, ".rooignore"), "blocked.ts\n", "utf8")
		await fs.writeFile(path.join(workspaceRoot, "blocked.ts"), "export const blocked = true\n", "utf8")
		await fs.writeFile(path.join(workspaceRoot, "allowed.ts"), "export const allowed = true\n", "utf8")

		const adapter = new VsCodeWorkspaceAdapter(workspaceRoot, { respectGitIgnore: false })
		await adapter.initialize()

		const discovered: string[] = []
		await adapter.enumerateCandidateFiles((filePath) => {
			discovered.push(path.relative(workspaceRoot, filePath).replace(/\\/g, "/"))
		})

		expect(discovered).toContain("allowed.ts")
		expect(discovered).not.toContain("blocked.ts")
	})
})
