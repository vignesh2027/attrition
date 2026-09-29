// Thin client for the Sanity Context MCP endpoint. Every call is recorded in a
// trace so the UI can show exactly which tool ran and which GROQ it sent.
import 'server-only'

export type TraceEntry = {tool: string; query?: string; ms: number; resultCount?: number}

export const MCP_URL =
  process.env.SANITY_CONTEXT_MCP_URL ?? 'https://api.sanity.io/v2026-03-03/context/mcp/y9raau23/production/semconv-sentinel'

function token() {
  const t = process.env.SANITY_API_READ_TOKEN
  if (!t) throw new Error('SANITY_API_READ_TOKEN is not set')
  return t
}

let rpcId = 0

async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  const res = await fetch(MCP_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token()}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: {name, arguments: args}}),
    cache: 'no-store',
  })
  if (!res.ok) throw new Error(`Context MCP ${name} failed: HTTP ${res.status}`)
  const body = await res.json()
  if (body.error) throw new Error(`Context MCP ${name} failed: ${body.error.message}`)
  if (body.result?.isError) throw new Error(`Context MCP ${name} failed: ${body.result.content?.[0]?.text}`)
  return body.result?.content?.[0]?.text ?? ''
}

export async function groq<T>(query: string, trace: TraceEntry[]): Promise<T> {
  const started = Date.now()
  const text = await callTool('groq_query', {query})
  const parsed = JSON.parse(text) as {meta?: {resultCount?: number}; result: T}
  trace.push({tool: 'groq_query', query, ms: Date.now() - started, resultCount: parsed.meta?.resultCount})
  return parsed.result
}

// GROQ has no bind parameters through the MCP tool, so literal values are
// escaped here. Keys come from our own extractor, but escape anyway.
export function groqString(s: string) {
  return JSON.stringify(s)
}
