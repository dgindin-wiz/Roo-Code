import { Suspense, lazy, memo } from "react"

const MarkdownBlock = lazy(() => import("./MarkdownBlock"))

const MarkdownBlockFallback = ({ markdown }: { markdown?: string }) => {
	if (!markdown) {
		return null
	}

	return <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", overflowWrap: "anywhere" }}>{markdown}</div>
}

const LazyMarkdownBlock = memo(({ markdown }: { markdown?: string }) => {
	return (
		<Suspense fallback={<MarkdownBlockFallback markdown={markdown} />}>
			<MarkdownBlock markdown={markdown} />
		</Suspense>
	)
})

export default LazyMarkdownBlock
