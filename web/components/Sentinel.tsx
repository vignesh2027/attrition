'use client'

import {useMemo, useState} from 'react'
import type {Finding, ScanResult} from '@/lib/analyze'
import type {Sample} from '@/lib/samples'
import {Chat} from './Chat'

const LINKS = {
  repo: 'https://github.com/vignesh2027/semconv-sentinel',
  studio: 'https://semconv-sentinel.sanity.studio',
  dataset:
    'https://y9raau23.apicdn.sanity.io/v2025-02-19/data/query/production?query=*%5B_type%3D%3D%22attribute%22%26%26status%3D%3D%22deprecated%22%5D%7Bkey%2Cdeprecation%7D%5B0...20%5D',
  spec: 'https://github.com/open-telemetry/semantic-conventions',
}

const VERDICT_LABEL: Record<string, string> = {
  RENAMED: 'Renamed',
  REPLACED: 'Replaced',
  SPAN_KIND_DEPENDENT: 'Depends on span kind',
  SPLIT: 'Split',
  CONDITIONAL: 'Conditional',
  MERGED_INTO: 'Merged into',
  USE_SIGNAL_FIELD: 'Use a signal field',
  MOVED_OUT: 'Moved out',
  REMOVED: 'Removed',
  NEEDS_REVIEW: 'Needs review',
  CURRENT: 'Current',
}

export function Sentinel({samples}: {samples: Sample[]}) {
  const [active, setActive] = useState(samples[0]?.id ?? '')
  const [code, setCode] = useState(samples[0]?.code ?? '')
  const [result, setResult] = useState<ScanResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [elapsed, setElapsed] = useState<number | null>(null)
  const origin = samples.find((s) => s.id === active)?.origin

  async function run(source = code) {
    setBusy(true)
    setError(null)
    const started = performance.now()
    try {
      const res = await fetch('/api/scan', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({code: source})})
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
      setResult(body)
      setElapsed(Math.round(performance.now() - started))
    } catch (err) {
      setResult(null)
      setError(err instanceof Error ? err.message : 'Scan failed')
    } finally {
      setBusy(false)
    }
  }

  function pick(s: Sample) {
    setActive(s.id)
    setCode(s.code)
    setResult(null)
    run(s.code)
  }

  const lineCount = useMemo(() => code.split('\n').length, [code])
  const flagged = useMemo(() => new Set(result?.findings.filter((f) => f.status === 'deprecated').flatMap((f) => f.lines)), [result])

  return (
    <main className="wrap">
      <header className="hero">
        <div className="brand">
          <span className="dot" aria-hidden />
          <span>Semconv Sentinel</span>
        </div>
        <h1>Find the OpenTelemetry attribute names the spec already retired.</h1>
        <p className="lede">
          Paste instrumentation code. Every attribute key and semconv constant is checked against all {''}
          <strong>940 attributes</strong> of the semantic conventions, stored as structured content in Sanity and read through Sanity
          Context. You get the verdict, the replacement for your span kind, the release that deprecated it, the spec line that says so, and a
          patch.
        </p>
        <nav className="links">
          <a href={LINKS.repo}>Code</a>
          <a href={LINKS.studio}>Sanity Studio</a>
          <a href={LINKS.dataset}>Public dataset (project y9raau23)</a>
          <a href={LINKS.spec}>Spec source</a>
        </nav>
      </header>

      <section className="samples" aria-label="Samples">
        {samples.map((s) => (
          <button key={s.id} className={`chip ${s.id === active ? 'on' : ''}`} onClick={() => pick(s)} disabled={busy}>
            <span>{s.label}</span>
            <small>{s.language}</small>
          </button>
        ))}
        <button
          className={`chip ${active === 'own' ? 'on' : ''}`}
          onClick={() => {
            setActive('own')
            setCode('')
            setResult(null)
          }}
        >
          <span>Paste your own</span>
          <small>any language</small>
        </button>
      </section>
      {origin && active !== 'own' && <p className="origin">{origin}</p>}

      <div className="grid">
        <section className="panel editor">
          <div className="panel-head">
            <span>Code</span>
            <span className="muted">{lineCount} lines</span>
          </div>
          <div className="code">
            <pre className="gutter" aria-hidden>
              {Array.from({length: lineCount}, (_, i) => (
                <span key={i} className={flagged.has(i + 1) ? 'hit' : ''}>
                  {i + 1}
                  {'\n'}
                </span>
              ))}
            </pre>
            <textarea
              value={code}
              rows={lineCount + 1}
              spellCheck={false}
              onChange={(e) => {
                setCode(e.target.value)
                setActive('own')
              }}
              placeholder={'span.set_attribute("http.method", "GET")'}
            />
          </div>
          <div className="actions">
            <button className="primary" onClick={() => run()} disabled={busy || !code.trim()}>
              {busy ? 'Checking against Sanity...' : 'Check attributes'}
            </button>
            {elapsed !== null && result && <span className="muted">{elapsed} ms, {result.trace.length} Context calls</span>}
          </div>
        </section>

        <section className="panel results">
          {error && <p className="error">{error}</p>}
          {!result && !error && <Empty busy={busy} />}
          {result && <Results result={result} />}
        </section>
      </div>

      <Chat code={code} />

      <footer className="foot">
        <p>
          Data: every tagged release of{' '}
          <a href={LINKS.spec}>open-telemetry/semantic-conventions</a> from v1.21.0 to {result?.specRelease ?? 'v1.44.0'}, imported into Sanity by a
          deterministic script. Verdicts are computed from the spec&apos;s own <code>reason</code>, <code>renamed_to</code> and <code>note</code> fields,
          never by a model.
        </p>
        <p>
          Built by <a href="https://github.com/vignesh2027">vignesh2027</a> for the DEV Sanity Challenge.
        </p>
      </footer>
    </main>
  )
}

function Empty({busy}: {busy: boolean}) {
  return (
    <div className="empty">
      <p>{busy ? 'Reading the spec from Sanity Context...' : 'Pick a sample or paste code, then press Check attributes.'}</p>
      <ul>
        <li>Finds string keys like <code>&quot;db.system&quot;</code></li>
        <li>Resolves SDK constants: <code>SEMATTRS_HTTP_METHOD</code>, <code>semconv.DBSystemKey</code>, <code>SpanAttributes.DB_STATEMENT</code></li>
        <li>Reads the span kind in your code, because <code>net.peer.name</code> has two different replacements</li>
      </ul>
    </div>
  )
}

function Results({result}: {result: ScanResult}) {
  const deprecated = result.findings.filter((f) => f.status === 'deprecated')
  const current = result.findings.filter((f) => f.status === 'current')
  const [copied, setCopied] = useState(false)

  return (
    <div className="results-body">
      <div className="stats">
        <Stat n={result.summary.usages} label="attribute usages" />
        <Stat n={result.summary.deprecated} label="deprecated" tone="warn" />
        <Stat n={result.summary.autoFixable} label="one clear replacement" tone="ok" />
        <Stat n={result.summary.needDecision} label="need a decision" />
      </div>
      <p className="meta">
        Checked against spec <strong>{result.specRelease}</strong>
        {result.pinnedVersion && (
          <>
            {' '}
            · your code pins <strong>{result.pinnedVersion.version}</strong> (line {result.pinnedVersion.line})
          </>
        )}
        {' '}· language: {result.language}
      </p>

      {deprecated.length === 0 && result.summary.usages > 0 && <p className="good">No deprecated attributes. Every key here is current in {result.specRelease}.</p>}
      {result.summary.usages === 0 && <p className="muted">No OpenTelemetry attribute keys or semconv constants found in this code.</p>}

      {result.migrationGuides.some((g) => g.optIn) && (
        <div className="guide top">
          <span className="kb">Knowledge Base</span>
          <span>
            {result.migrationGuides
              .filter((g) => g.optIn)
              .map((g) => (
                <span key={g.entry} className="block">
                  <strong>{g.entry.split('/').pop()}:</strong> <Inline text={g.optIn!} />
                </span>
              ))}
          </span>
        </div>
      )}

      <ol className="findings">
        {deprecated.map((f) => (
          <FindingCard key={`${f.key}-${f.spanKind}-${f.lines[0]}`} f={f} pinned={result.pinnedVersion?.version} />
        ))}
      </ol>

      {current.length > 0 && (
        <details className="current">
          <summary>{current.length} current {current.length === 1 ? 'attribute' : 'attributes'}</summary>
          <ul>
            {current.map((f) => (
              <li key={f.key}>
                <a href={f.sourceUrl}>
                  <code>{f.key}</code>
                </a>{' '}
                <span className="muted">
                  {f.stability}, line {f.lines.join(', ')}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {result.unknown.length > 0 && (
        <details className="current" open>
          <summary>
            {result.unknown.length} {result.unknown.length === 1 ? 'key uses' : 'keys use'} a spec namespace but {result.unknown.length === 1 ? 'is' : 'are'} not in the spec
          </summary>
          <ul>
            {result.unknown.map((u) => (
              <li key={u.key}>
                <code>{u.key}</code>{' '}
                <span className="muted">
                  line {u.line}. The <code>{u.namespace}.</code> namespace belongs to the spec, so a future release may define this key differently.
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {result.patch && (
        <div className="patch">
          <div className="panel-head">
            <span>Patch for the safe renames</span>
            <button
              className="ghost"
              onClick={() => {
                navigator.clipboard.writeText(result.patch!)
                setCopied(true)
                setTimeout(() => setCopied(false), 1500)
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <pre>
            {result.patch.split('\n').map((l, i) => (
              <span key={i} className={l.startsWith('+') && !l.startsWith('+++') ? 'add' : l.startsWith('-') && !l.startsWith('---') ? 'del' : ''}>
                {l}
                
              </span>
            ))}
          </pre>
          <p className="muted small">Only string keys with a single, unconditional replacement are patched. Everything else needs a person.</p>
        </div>
      )}

      <details className="trace" open>
        <summary>How this answer was built ({result.trace.length} Sanity Context calls)</summary>
        <ol>
          {result.trace.map((t, i) => (
            <li key={i}>
              <span className="tool">{t.tool}</span>
              <span className="muted">
                {' '}
                {t.ms} ms{t.resultCount !== undefined ? `, ${t.resultCount} documents` : ''}
              </span>
              {t.query && <pre>{t.query.replace(/\s+/g, ' ').trim()}</pre>}
            </li>
          ))}
        </ol>
      </details>
    </div>
  )
}

// Renders the two inline markdown forms the spec text uses: `code` and [text](url).
function Inline({text}: {text: string}) {
  const parts = text.split(/(`[^`]+`|\[[^\]]+\]\([^)]+\))/g)
  return (
    <>
      {parts.map((p, i) => {
        if (p.startsWith('`') && p.endsWith('`')) return <code key={i}>{p.slice(1, -1)}</code>
        const link = p.match(/^\[([^\]]+)\]\(([^)]+)\)$/)
        if (link) return <a key={i} href={link[2]}>{link[1]}</a>
        return <span key={i}>{p}</span>
      })}
    </>
  )
}

function Stat({n, label, tone}: {n: number; label: string; tone?: 'warn' | 'ok'}) {
  return (
    <div className={`stat ${tone ?? ''}`}>
      <strong>{n}</strong>
      <span>{label}</span>
    </div>
  )
}

function FindingCard({f, pinned}: {f: Finding; pinned?: string}) {
  return (
    <li className={`finding v-${f.verdict}`}>
      <div className="finding-head">
        <code className="old">{f.key}</code>
        <span className="arrow" aria-hidden>
          →
        </span>
        {f.replacement ? (
          <code className="new">{f.replacement}</code>
        ) : (
          <span className="open">{f.verdict === 'REMOVED' ? 'delete it' : 'your call'}</span>
        )}
        <span className="badge">{VERDICT_LABEL[f.verdict] ?? f.verdict}</span>
      </div>
      <p className="why">
        <Inline text={f.replacementReason} />
      </p>
      {f.verdict === 'SPAN_KIND_DEPENDENT' && (
        <table className="kinds">
          <tbody>
            {f.replacements.map((r) => (
              <tr key={r.key} className={f.spanKind && r.when.startsWith(f.spanKind) ? 'chosen' : ''}>
                <td>{r.when}</td>
                <td>
                  <code>{r.key}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {f.verdict === 'SPLIT' && (
        <p className="small">
          Set together:{' '}
          {f.replacements.map((r) => (
            <code key={r.key}>{r.key} </code>
          ))}
        </p>
      )}
      {f.movedTo && (
        <p className="small">
          Now maintained in <a href={f.movedTo.url}>{f.movedTo.label}</a>.
        </p>
      )}
      <dl className="facts">
        <div>
          <dt>Lines</dt>
          <dd>
            {f.lines.join(', ')} <span className="muted">({f.forms.join(', ')})</span>
          </dd>
        </div>
        {f.spanKind && f.verdict === 'SPAN_KIND_DEPENDENT' && (
          <div>
            <dt>Span kind</dt>
            <dd>
              {f.spanKind} <span className="muted">(stated on line {f.spanKindLine})</span>
            </dd>
          </div>
        )}
        {f.deprecatedIn && (
          <div>
            <dt>Deprecated in</dt>
            <dd>
              {f.deprecatedIn === 'v1.21.0' ? 'v1.21.0 or earlier' : f.deprecatedIn}
              {pinned && f.deprecatedInPinned !== null && (
                <span className={f.deprecatedInPinned ? 'warn-text' : 'muted'}>
                  {f.deprecatedInPinned ? ` (already deprecated in your pinned ${pinned})` : ` (after your pinned ${pinned})`}
                </span>
              )}
            </dd>
          </div>
        )}
        <div>
          <dt>Source</dt>
          <dd>
            <a href={f.sourceUrl}>spec YAML line</a> · <span className="muted">{f.documentId}</span>
          </dd>
        </div>
      </dl>
      {f.note && f.verdict !== 'RENAMED' && f.verdict !== 'MOVED_OUT' && f.note !== f.replacementReason && (
        <p className="note">
          <Inline text={f.note} />
        </p>
      )}
      {f.guidance && (
        <div className="guide">
          <span className="kb">Knowledge Base</span>
          <span>
            Migration guide{f.guidance.section ? <>, {f.guidance.section}</> : ''}: <code>{f.guidance.change}</code>
            {f.guidance.comment ? (
              <>
                . <Inline text={f.guidance.comment} />
              </>
            ) : (
              '. No extra behaviour change listed.'
            )}
            {f.guidance.disagreesWithRegistry && (
              <strong className="block warn-text">The registry and the migration guide disagree here, so this key is left out of the patch.</strong>
            )}
            {f.guidance.appliesToOtherSpanKind && (
              <strong className="block warn-text">
                The guide lists this under {f.guidance.section?.toLowerCase().includes('client') ? 'client' : 'server'} spans only. This usage is on a {f.spanKind}{' '}
                span, so the registry answer above applies instead.
              </strong>
            )}
          </span>
        </div>
      )}
    </li>
  )
}
