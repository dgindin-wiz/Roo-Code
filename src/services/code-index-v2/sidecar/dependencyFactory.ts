import { getDefaultModelId } from "../../../shared/embeddingModels"
import { BedrockEmbedder } from "../../code-index/embedders/bedrock"
import { GeminiEmbedder } from "../../code-index/embedders/gemini"
import { MistralEmbedder } from "../../code-index/embedders/mistral"
import { CodeIndexOllamaEmbedder } from "../../code-index/embedders/ollama"
import { OpenAiEmbedder } from "../../code-index/embedders/openai"
import { OpenAICompatibleEmbedder } from "../../code-index/embedders/openai-compatible"
import { OpenRouterEmbedder } from "../../code-index/embedders/openrouter"
import { VercelAiGatewayEmbedder } from "../../code-index/embedders/vercel-ai-gateway"
import { IEmbedder } from "../../code-index/interfaces"
import { ExistingEmbedderAdapter } from "../adapters/ExistingEmbedderAdapter"
import { QdrantRestVectorStoreAdapter } from "../adapters/QdrantRestVectorStoreAdapter"
import { SidecarInitPayload } from "./protocol"

function createEmbedder(config: SidecarInitPayload["config"]): IEmbedder {
	const provider = config.embedderProvider
	const modelId = config.modelId ?? getDefaultModelId(provider)

	switch (provider) {
		case "openai": {
			const apiKey = config.openAiOptions?.openAiNativeApiKey
			if (!apiKey) {
				throw new Error("Code index sidecar requires an OpenAI API key")
			}
			return new OpenAiEmbedder({
				...config.openAiOptions,
				openAiEmbeddingModelId: modelId,
			})
		}
		case "ollama": {
			const baseUrl = config.ollamaOptions?.ollamaBaseUrl
			if (!baseUrl) {
				throw new Error("Code index sidecar requires an Ollama base URL")
			}
			return new CodeIndexOllamaEmbedder({
				...config.ollamaOptions,
				ollamaModelId: modelId,
			})
		}
		case "openai-compatible": {
			const baseUrl = config.openAiCompatibleOptions?.baseUrl
			const apiKey = config.openAiCompatibleOptions?.apiKey
			if (!baseUrl || !apiKey) {
				throw new Error("Code index sidecar requires OpenAI-compatible credentials")
			}
			return new OpenAICompatibleEmbedder(baseUrl, apiKey, modelId)
		}
		case "gemini": {
			const apiKey = config.geminiOptions?.apiKey
			if (!apiKey) {
				throw new Error("Code index sidecar requires a Gemini API key")
			}
			return new GeminiEmbedder(apiKey, modelId)
		}
		case "mistral": {
			const apiKey = config.mistralOptions?.apiKey
			if (!apiKey) {
				throw new Error("Code index sidecar requires a Mistral API key")
			}
			return new MistralEmbedder(apiKey, modelId)
		}
		case "vercel-ai-gateway": {
			const apiKey = config.vercelAiGatewayOptions?.apiKey
			if (!apiKey) {
				throw new Error("Code index sidecar requires a Vercel AI Gateway API key")
			}
			return new VercelAiGatewayEmbedder(apiKey, modelId)
		}
		case "bedrock": {
			const region = config.bedrockOptions?.region
			if (!region) {
				throw new Error("Code index sidecar requires a Bedrock region")
			}
			return new BedrockEmbedder(region, config.bedrockOptions?.profile, modelId)
		}
		case "openrouter": {
			const apiKey = config.openRouterOptions?.apiKey
			if (!apiKey) {
				throw new Error("Code index sidecar requires an OpenRouter API key")
			}
			return new OpenRouterEmbedder(apiKey, modelId, undefined, config.openRouterOptions?.specificProvider)
		}
		default:
			throw new Error(`Unsupported code index sidecar provider: ${provider}`)
	}
}

export function createSidecarDependencies(payload: SidecarInitPayload) {
	const embedder = createEmbedder(payload.config)
	const embeddingAdapter = new ExistingEmbedderAdapter(embedder, {
		modelId: payload.runtime.modelId,
		runtimeKind: payload.runtime.runtimeKind,
		runtimeLabel: payload.runtime.runtimeLabel,
		deviceHint: payload.runtime.deviceHint,
	})
	const qdrantUrl = payload.config.qdrantUrl
	if (!qdrantUrl) {
		throw new Error("Code index sidecar requires a Qdrant URL")
	}
	const vectorStore = new QdrantRestVectorStoreAdapter(
		payload.workspacePath,
		qdrantUrl,
		payload.vectorSize,
		payload.config.qdrantApiKey,
	)
	return {
		embeddingAdapter,
		vectorStore,
	}
}
