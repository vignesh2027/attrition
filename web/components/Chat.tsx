'use client'

import {useChat} from '@ai-sdk/react'
import {useState} from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

const STARTERS = [
  'Which attributes changed for database spans, and in which release?',
  'My HTTP server sets net.peer.name. What should it set now?',
  'Which gen_ai attributes moved out of the main repository, and where to?',
]

export function Chat({code}: {code: string}) {
  const {messages, sendMessage, status, error} = useChat()
  const [input, setInput] = useState('')
  const busy = status === 'submitted' || status === 'streaming'

  function send(text: string) {
    if (!text.trim() || busy) return
    sendMessage({text})
    setInput('')
  }

  return (
    <section className="panel chat">
      <div className="panel-head">
        <span>Ask the agent</span>
        <span className="muted">answers from Sanity Context: the semantic conventions dataset and the migration guide Knowledge Base</span>
      </div>
      <div className="chat-log">
        {messages.length === 0 && (
          <div className="starters">
            {STARTERS.map((s) => (
              <button key={s} className="ghost" onClick={() => send(s)}>
                {s}
              </button>
            ))}
            <button className="ghost" onClick={() => send(`Check this code and explain what to change:\n\n\`\`\`\n${code}\n\`\`\``)} disabled={!code.trim()}>
              Explain the code in the editor
            </button>
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`msg ${m.role}`}>
            {m.parts.map((p, i) => {
              if (p.type === 'text') {
                return m.role === 'user' ? (
                  <p key={i} className="user-text">
                    {p.text.length > 400 ? `${p.text.slice(0, 400)}...` : p.text}
                  </p>
                ) : (
                  <div key={i} className="md">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{p.text}</ReactMarkdown>
                  </div>
                )
              }
              if (p.type === 'data-trace') {
                const calls = (p as {data: Array<{tool: string; query?: string; ms: number; resultCount?: number}>}).data
                return (
                  <details key={i} className="toolcalls">
                    <summary>{calls.length} Sanity Context calls behind this answer</summary>
                    {calls.map((c, j) => (
                      <div key={j} className="toolcall">
                        <span className="tool">{c.tool}</span>
                        <span className="muted">
                          {c.ms} ms{c.resultCount !== undefined ? `, ${c.resultCount} docs` : ''}
                        </span>
                        {c.query && <code>{c.query.replace(/\s+/g, ' ').slice(0, 140)}</code>}
                      </div>
                    ))}
                  </details>
                )
              }
              if (p.type.startsWith('tool-') || p.type === 'dynamic-tool') {
                const name = p.type === 'dynamic-tool' ? (p as {toolName: string}).toolName : p.type.slice(5)
                const input = (p as {input?: {query?: string}}).input
                return (
                  <div key={i} className="toolcall">
                    <span className="tool">{name}</span>
                    {input?.query && <code>{input.query.replace(/\s+/g, ' ').slice(0, 160)}</code>}
                  </div>
                )
              }
              return null
            })}
          </div>
        ))}
        {error && <p className="error">{error.message}</p>}
      </div>
      <form
        className="chat-input"
        onSubmit={(e) => {
          e.preventDefault()
          send(input)
        }}
      >
        <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Ask about any attribute, namespace or release" />
        <button className="primary" disabled={busy || !input.trim()}>
          {busy ? 'Thinking...' : 'Ask'}
        </button>
      </form>
    </section>
  )
}
