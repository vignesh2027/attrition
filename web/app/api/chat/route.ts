import {createGroq} from '@ai-sdk/groq'
import {convertToModelMessages, createUIMessageStream, createUIMessageStreamResponse, streamText, type UIMessage} from 'ai'
import {retrieve} from '@/lib/retrieve'

export const runtime = 'nodejs'
export const maxDuration = 60

const MAX_HISTORY = 6

// Three models, each with its own free-tier budget of about 8,000 tokens a
// minute. The route picks whichever has spent the least in the last minute.
const MODELS = (process.env.GROQ_MODELS ?? 'openai/gpt-oss-120b,openai/gpt-oss-20b,qwen/qwen3.8-27b').split(',')
const spent = new Map<string, Array<{at: number; tokens: number}>>()

function pickModel() {
  const now = Date.now()
  let best = MODELS[0]
  let bestUse = Infinity
  for (const m of MODELS) {
    const recent = (spent.get(m) ?? []).filter((e) => now - e.at < 60_000)
    spent.set(m, recent)
    const use = recent.reduce((a, e) => a + e.tokens, 0)
    if (use < bestUse) {
      best = m
      bestUse = use
    }
  }
  return best
}

const SYSTEM = `
You are Attrition, an agent for OpenTelemetry semantic conventions. You tell engineers which attribute names the spec has retired and exactly what to use instead.

Answer only from the EVIDENCE block. It was fetched for this question from Sanity:
- "attributes" and "namespaces" come from the attribute dataset through Sanity Context groq_query. They are the only source for verdicts, replacement keys and release numbers.
- "guideRows" come from the official migration guides in the Sanity Knowledge Base through knowledge_base_read. Use them for behaviour changes, privacy notes, and OTEL_SEMCONV_STABILITY_OPT_IN values.
- "scan" is present when the user pasted code.

Rules:
- Never invent a key, a release number, a step or a timeline that is not in the evidence. If the evidence does not answer the question, say so and suggest a more specific question.
- SPAN_KIND_DEPENDENT: replacements[].when says "client spans" or "server spans". If the user did not say which, give both and ask.
- Cite the dataset (src links, or "Sanity dataset") for verdicts and releases, and the Knowledge Base entry path (for example migration/guides/http) for guide text. Do not attribute dataset facts to a guide.
- Cite inline in plain parentheses, for example (Sanity dataset) or (migration/guides/http).
- Start with the direct answer. Then a small table if it helps. Keep it short.
- Never use em dashes or en dashes. Use commas, colons or parentheses.
`.trim()

function lastUserText(messages: UIMessage[]) {
  const last = [...messages].reverse().find((m) => m.role === 'user')
  return last?.parts.map((p) => (p.type === 'text' ? p.text : '')).join('\n') ?? ''
}

export async function POST(req: Request) {
  const {messages}: {messages: UIMessage[]} = await req.json()
  if (!process.env.GROQ_API_KEY) {
    return Response.json({error: 'The chat agent needs GROQ_API_KEY. Scanning still works without it.'}, {status: 503})
  }

  const question = lastUserText(messages)
  const stream = createUIMessageStream({
    originalMessages: messages,
    onError: (err) => {
      const msg = err instanceof Error ? err.message : String(err)
      return /rate_limit|tokens per minute|TPM|429/i.test(msg)
        ? 'The free model tier is busy. Wait a minute and ask again. The scanner above does not use the model and keeps working.'
        : 'The agent hit an error. The scanner above still works.'
    },
    execute: async ({writer}) => {
      const evidence = await retrieve(question)
      // Shown in the UI as the list of Sanity Context calls behind the answer.
      writer.write({type: 'data-trace', data: evidence.trace})

      const {trace: _trace, ...forModel} = evidence
      const model = pickModel()
      const groq = createGroq({apiKey: process.env.GROQ_API_KEY})
      const result = streamText({
        model: groq(model),
        instructions: `${SYSTEM}\n\nEVIDENCE\n${JSON.stringify(forModel)}`,
        messages: await convertToModelMessages(messages.slice(-MAX_HISTORY)),
        onEnd: ({usage}) => {
          const tokens = (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0)
          spent.set(model, [...(spent.get(model) ?? []), {at: Date.now(), tokens: tokens || 3000}])
        },
      })
      // Belt and braces for the house style: the model is told not to use
      // em or en dashes, and any that slip through are replaced here.
      const noDashes = new TransformStream({
        transform(chunk: {type: string; delta?: string}, controller) {
          if (chunk.type === 'text-delta' && chunk.delta) chunk = {...chunk, delta: chunk.delta.replace(/[\u2013\u2014]/g, '-').replace(/\u3010/g, ' (').replace(/\u3011/g, ')')}
          controller.enqueue(chunk)
        },
      })
      writer.merge(result.toUIMessageStream({sendStart: false}).pipeThrough(noDashes))
    },
  })
  return createUIMessageStreamResponse({stream})
}
