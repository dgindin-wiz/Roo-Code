import path, { resolve } from "path"
import fs from "fs"
import { execSync } from "child_process"
import { builtinModules } from "module"

import { defineConfig, type PluginOption, type Plugin } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

import { sourcemapPlugin } from "./src/vite-plugins/sourcemapPlugin"

function getGitSha() {
	let gitSha: string | undefined = undefined

	try {
		gitSha = execSync("git rev-parse HEAD").toString().trim()
	} catch (_error) {
		// Do nothing.
	}

	return gitSha
}

const wasmPlugin = (): Plugin => ({
	name: "wasm",
	async load(id) {
		if (id.endsWith(".wasm")) {
			const wasmBinary = await import(id)

			return `
           			const wasmModule = new WebAssembly.Module(${wasmBinary.default});
           			export default wasmModule;
         		`
		}
	},
})

const persistPortPlugin = (): Plugin => ({
	name: "write-port-to-file",
	configureServer(viteDevServer) {
		viteDevServer?.httpServer?.once("listening", () => {
			const address = viteDevServer?.httpServer?.address()
			const port = address && typeof address === "object" ? address.port : null

			if (port) {
				fs.writeFileSync(resolve(__dirname, "..", ".vite-port"), port.toString())
				console.log(`[Vite Plugin] Server started on port ${port}`)
			} else {
				console.warn("[Vite Plugin] Could not determine server port")
			}
		})
	},
})

const nodeBuiltins = new Set(builtinModules.map((moduleName) => moduleName.replace(/^node:/, "")))
const forbiddenBrowserImports = new Set(
	[...nodeBuiltins, "fs/promises", "path", "os", "child_process", "readline"].map((moduleName) =>
		moduleName.replace(/^node:/, ""),
	),
)
const browserSourceRoots = [resolve(__dirname, "src"), resolve(__dirname, "../src")].map(
	(dir) => dir.replace(/\\/g, "/") + "/",
)

const nodeBuiltinGuardPlugin = (): Plugin => ({
	name: "node-builtin-guard",
	resolveId(source, importer) {
		if (!importer || source === "vscode") {
			return null
		}

		const normalizedImporter = importer.replace(/\\/g, "/")
		const isBrowserSource =
			browserSourceRoots.some((root) => normalizedImporter.startsWith(root)) &&
			!normalizedImporter.includes("/node_modules/")

		if (!isBrowserSource) {
			return null
		}

		const normalizedSource = source.replace(/^node:/, "")
		if (!forbiddenBrowserImports.has(normalizedSource)) {
			return null
		}

		throw new Error(
			`Node builtin "${source}" cannot be imported from browser-targeted source: ${normalizedImporter}`,
		)
	},
})

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
	let outDir = "../src/webview-ui/build"
	const enableWebviewSourceMaps = process.env.ROO_ENABLE_WEBVIEW_SOURCE_MAPS === "true"

	const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "src", "package.json"), "utf8"))
	const gitSha = getGitSha()

	const define: Record<string, any> = {
		"process.platform": JSON.stringify(process.platform),
		"process.env.VSCODE_TEXTMATE_DEBUG": JSON.stringify(process.env.VSCODE_TEXTMATE_DEBUG),
		"process.env.PKG_NAME": JSON.stringify(pkg.name),
		"process.env.PKG_VERSION": JSON.stringify(pkg.version),
		"process.env.PKG_BUILD_TIMESTAMP": JSON.stringify(new Date().toISOString()),
		"process.env.PKG_OUTPUT_CHANNEL": JSON.stringify("Roo-Code"),
		"process.env.PKG_ENABLE_WEBVIEW_SOURCE_MAPS": JSON.stringify(enableWebviewSourceMaps ? "true" : "false"),
		...(gitSha ? { "process.env.PKG_SHA": JSON.stringify(gitSha) } : {}),
	}

	// TODO: We can use `@roo-code/build` to generate `define` once the
	// monorepo is deployed.
	if (mode === "nightly") {
		outDir = "../apps/vscode-nightly/build/webview-ui/build"

		const nightlyPkg = JSON.parse(
			fs.readFileSync(path.join(__dirname, "..", "apps", "vscode-nightly", "package.nightly.json"), "utf8"),
		)

		define["process.env.PKG_NAME"] = JSON.stringify(nightlyPkg.name)
		define["process.env.PKG_VERSION"] = JSON.stringify(nightlyPkg.version)
		define["process.env.PKG_OUTPUT_CHANNEL"] = JSON.stringify("Roo-Code-Nightly")
	}

	const plugins: PluginOption[] = [
		react({
			babel: {
				plugins: [["babel-plugin-react-compiler", { target: "18" }]],
			},
		}),
		tailwindcss(),
		persistPortPlugin(),
		nodeBuiltinGuardPlugin(),
		wasmPlugin(),
	]

	if (enableWebviewSourceMaps) {
		plugins.push(sourcemapPlugin())
	}

	return {
		plugins,
		resolve: {
			alias: {
				"@": resolve(__dirname, "./src"),
				"@src": resolve(__dirname, "./src"),
				"@roo": resolve(__dirname, "../src/shared"),
			},
		},
		build: {
			outDir,
			emptyOutDir: true,
			reportCompressedSize: false,
			sourcemap: enableWebviewSourceMaps,
			minify: mode === "production" ? "esbuild" : false,
			// Use a single combined CSS bundle so all webviews share styles
			cssCodeSplit: false,
			rollupOptions: {
				// The VS Code API is provided at runtime by the host and should not be bundled.
				external: ["vscode"],
				input: {
					index: resolve(__dirname, "index.html"),
				},
				output: {
					entryFileNames: `assets/[name].js`,
					chunkFileNames: (chunkInfo) => {
						if (chunkInfo.name === "mermaid-bundle") {
							return `assets/mermaid-bundle.js`
						}
						// Default naming for other chunks, ensuring uniqueness from entry
						return `assets/chunk-[hash].js`
					},
					assetFileNames: (assetInfo) => {
						const name = assetInfo.name || ""

						// Force all CSS into a single predictable file used by both webviews
						if (name.endsWith(".css")) {
							return "assets/index.css"
						}

						if (name.endsWith(".woff2") || name.endsWith(".woff") || name.endsWith(".ttf")) {
							return "assets/fonts/[name][extname]"
						}
						// Ensure source maps are included in the build
						if (name.endsWith(".map")) {
							return "assets/[name]"
						}
						return "assets/[name][extname]"
					},
					manualChunks: (id, { getModuleInfo }) => {
						if (
							id.includes("/src/components/settings/") ||
							id.includes("/src/components/history/") ||
							id.includes("/src/components/marketplace/") ||
							id.includes("/src/components/cloud/")
						) {
							return "tab-features"
						}

						if (
							id.includes("node_modules/react-markdown") ||
							id.includes("node_modules/remark-gfm") ||
							id.includes("node_modules/remark-math") ||
							id.includes("node_modules/rehype-katex") ||
							id.includes("node_modules/katex") ||
							id.includes("node_modules/shiki")
						) {
							return "rich-rendering"
						}

						// Consolidate all mermaid code and its direct large dependencies (like dagre)
						// into a single chunk. The 'channel.js' error often points to dagre.
						if (
							id.includes("node_modules/mermaid") ||
							id.includes("node_modules/dagre") || // dagre is a common dep for graph layout
							id.includes("node_modules/cytoscape") // another potential graph lib
							// Add other known large mermaid dependencies if identified
						) {
							return "mermaid-bundle"
						}

						// Check if the module is part of any explicitly defined mermaid-related dynamic import
						// This is a more advanced check if simple path matching isn't enough.
						const moduleInfo = getModuleInfo(id)
						if (moduleInfo?.importers.some((importer) => importer.includes("node_modules/mermaid"))) {
							return "mermaid-bundle"
						}
						if (
							moduleInfo?.dynamicImporters.some((importer) => importer.includes("node_modules/mermaid"))
						) {
							return "mermaid-bundle"
						}
					},
				},
			},
		},
		server: {
			hmr: {
				host: "localhost",
				protocol: "ws",
			},
			cors: {
				origin: "*",
				methods: "*",
				allowedHeaders: "*",
			},
		},
		define,
		optimizeDeps: {
			include: [
				"mermaid",
				"dagre", // Explicitly include dagre for pre-bundling
				// Add other known large mermaid dependencies if identified
			],
			exclude: ["@vscode/codicons", "vscode-oniguruma", "shiki"],
		},
		assetsInclude: ["**/*.wasm", "**/*.wav"],
	}
})
