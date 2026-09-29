import {createGroq} from '@ai-sdk/groq'
import {createMCPClient, type MCPClient} from '@ai-sdk/mcp'
import {convertToModelMessages, stepCountIs, streamText, tool, type UIMessage} from 'ai'
import {z} from 'zod'
import {scan} from '@/lib/analyze'
import {MCP_URL} from '@/lib/context'

export const runtime = 'nodejs'
export const maxDuration = 60

const MAX_STEPS = 8

let initialContext: {text: string; at: number} | null = null

async function fetchInitialContext() {
  if (initialContext && Date.now() - initialContext.at < 10 * 60_000) return initialContext.text
  const url = new URL(MCP_URL)
  url.pathname = `${url.pathname.replace(/\/$/, '')}/initial-context`
  const res = await fetch(url, {headers: {Authorization: `Bearer ${process.env.SANITY_API_READ_TOKEN}`}})
  if (!res.ok) return ''
  initialContext = {text: await res.text(), at: Date.now()}
  return initialContext.text
}

const SYSTEM = `
You are Semconv Sentinel. You help engineers find OpenTelemetry attribute names that the semantic conventions have deprecated, and tell them exactly what to use instead.

Rules:
- Answer only from the Sanity dataset (groq_query) and, when available, the Knowledge Base tools. If the data does not say it, say you do not know.
- When the user pastes code, call scan_code first. It extracts every attribute and reads each verdict from Sanity. Then explain the findings.
- Never invent a replacement key. Use deprecation.replacements exactly as stored.
- For SPAN_KIND_DEPENDENT attributes, the answer depends on client vs server. If the span kind is unknown, ask.
- Link every attribute you discuss to its source.url (the exact spec YAML line).
- Be brief. Use short paragraphs and small tables. Do not use em dashes.
`.trim()

export async function POST(req: Request) {
  const {messages}: {messages: UIMessage[]} = await req.json()

  if (!process.env.GROQ_API_KEY) {
    return Response.json({error: 'The chat agent needs GROQ_API_KEY. Scanning still works without it.'}, {status: 503})
  }

  const clients: MCPClient[] = []
  const closeAll = async () => {
    await Promise.all(clients.map((c) => c.close().catch(() => {})))
  }

  try {
    const dataset = await createMCPClient({
      transport: {type: 'http', url: MCP_URL, headers: {Authorization: `Bearer ${process.env.SANITY_API_READ_TOKEN}`}},
    })
    clients.push(dataset)
    const {initial_context: _skip, ...datasetTools} = await dataset.tools()

    // Knowledge Base endpoint (organization level), when configured.
    let kbTools = {}
    if (process.env.SANITY_KB_MCP_URL && process.env.SANITY_ORGANIZATION_TOKEN) {
      const kb = await createMCPClient({
        transport: {
          type: 'http',
          url: process.env.SANITY_KB_MCP_URL,
          headers: {Authorization: `Bearer ${process.env.SANITY_ORGANIZATION_TOKEN}`},
        },
      })
      clients.push(kb)
      kbTools = Object.fromEntries(Object.entries(await kb.tools()).map(([name, t]) => [`kb_${name}`, t]))
    }

    const groq = createGroq({apiKey: process.env.GROQ_API_KEY})
    const context = await fetchInitialContext()

    const result = streamText({
      model: groq(process.env.GROQ_MODEL ?? 'openai/gpt-oss-120b'),
      instructions: `${SYSTEM}\n\n# Data reference\n\n${context}`,
      messages: await convertToModelMessages(messages),
      tools: {
        ...datasetTools,
        ...kbTools,
        scan_code: tool({
          description:
            'Scan a code snippet for OpenTelemetry attribute keys and semconv constants. Returns each attribute with its verdict from Sanity, the replacement for the span kind found in the code, and a unified diff for safe string renames.',
          inputSchema: z.object({code: z.string().describe('The source code to scan, verbatim')}),
          execute: async ({code}) => {
            const r = await scan(code)
            return {
              specRelease: r.specRelease,
              pinnedVersion: r.pinnedVersion,
              summary: r.summary,
              findings: r.findings.map((f) => ({
                key: f.key,
                verdict: f.verdict,
                lines: f.lines,
                spanKind: f.spanKind,
                replacement: f.replacement,
                why: f.replacementReason,
                deprecatedIn: f.deprecatedIn,
                source: f.sourceUrl,
              })),
              patch: r.patch,
            }
          },
        }),
      },
      stopWhen: stepCountIs(MAX_STEPS),
      onEnd: closeAll,
    })
    return result.toUIMessageStreamResponse({originalMessages: messages})
  } catch (err) {
    await closeAll()
    return Response.json({error: err instanceof Error ? err.message : 'Chat failed'}, {status: 500})
  }
}
