// Thin client for the Sanity Context MCP endpoint. Every call is recorded in a
// trace so the UI can show exactly which tool ran and which GROQ it sent.
import 'server-only'

export type TraceEntry = {tool: string; query?: string; ms: number; resultCount?: number}

export const MCP_URL =
  process.env.SANITY_CONTEXT_MCP_URL ?? 'https://api.sanity.io/v2026-03-03/context/mcp/y9raau23/production/attrition'

function token() {
  const t = process.env.SANITY_API_READ_TOKEN
  if (!t) throw new Error('SANITY_API_READ_TOKEN is not set')
  return t
}

let rpcId = 0

export const KB_MCP_URL = process.env.SANITY_KB_MCP_URL ?? ''
export const KB_ID = process.env.SANITY_KB_ID ?? ''

async function callTool(name: string, args: Record<string, unknown>, url = MCP_URL, bearer = token()): Promise<string> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${bearer}`,
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

// Reads Knowledge Base entries through the organization-level Context MCP
// endpoint. Returns null when the Knowledge Base is not configured.
export async function kbRead(paths: string[], trace: TraceEntry[]): Promise<string | null> {
  const orgToken = process.env.SANITY_ORGANIZATION_TOKEN
  if (!KB_MCP_URL || !KB_ID || !orgToken || !paths.length) return null
  const started = Date.now()
  const text = await callTool('knowledge_base_read', {knowledgeBase: KB_ID, paths}, KB_MCP_URL, orgToken)
  trace.push({tool: 'knowledge_base_read', query: paths.join(', '), ms: Date.now() - started, resultCount: paths.length})
  return text
}

// Keyword search over the Knowledge Base. Returns entry paths ranked by score.
export async function kbSearch(query: string, trace: TraceEntry[], limit = 3): Promise<Array<{path: string; score: number}>> {
  const orgToken = process.env.SANITY_ORGANIZATION_TOKEN
  if (!KB_MCP_URL || !KB_ID || !orgToken) return []
  const started = Date.now()
  const text = await callTool('knowledge_base_search', {knowledgeBase: KB_ID, query, limit}, KB_MCP_URL, orgToken)
  const hits = [...text.matchAll(/`([a-z0-9_/]+)`\s*\(score\s*([\d.]+)\)/g)].map((m) => ({path: m[1], score: Number(m[2])}))
  trace.push({tool: 'knowledge_base_search', query, ms: Date.now() - started, resultCount: hits.length})
  return hits
}

// The Knowledge Base outline, for the chat agent's system prompt.
export async function kbInitialContext(): Promise<string> {
  const orgToken = process.env.SANITY_ORGANIZATION_TOKEN
  if (!KB_MCP_URL || !orgToken) return ''
  return callTool('initial_context', {}, KB_MCP_URL, orgToken).catch(() => '')
}

// GROQ has no bind parameters through the MCP tool, so literal values are
// escaped here. Keys come from our own extractor, but escape anyway.
export function groqString(s: string) {
  return JSON.stringify(s)
}
