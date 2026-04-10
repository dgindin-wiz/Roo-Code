import { Suspense, lazy, memo, type ComponentProps } from "react"

const CodeBlock = lazy(() => import("./CodeBlock"))

const CodeBlockFallback = ({ source, language }: { source?: string; language: string }) => (
	<pre style={{ margin: 0, padding: "10px", overflowX: "auto" }}>
		<code className={`language-${language}`}>{source || ""}</code>
	</pre>
)

const LazyCodeBlock = memo((props: ComponentProps<typeof CodeBlock> & { source?: string; language: string }) => (
	<Suspense fallback={<CodeBlockFallback source={props.source} language={props.language} />}>
		<CodeBlock {...props} />
	</Suspense>
))

export default LazyCodeBlock
