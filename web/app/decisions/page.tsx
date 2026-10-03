import type {Metadata} from 'next'
import Link from 'next/link'
import {loadDecisions} from '@/lib/decisions'

export const metadata: Metadata = {
  title: 'Decisions: Attrition',
  description: 'Where the OpenTelemetry registry and the official migration guides disagreed, both claims, and the one Attrition treats as ground truth.',
}

// Read from the Knowledge Base at most every five minutes.
export const revalidate = 300

export default async function DecisionsPage() {
  const data = await loadDecisions().catch(() => null)

  return (
    <main className="wrap">
      <header className="hero">
        <Link href="/" className="brand">
          <img src="/mark.svg" alt="" width={34} height={34} />
          <span>Attrition</span>
          <span className="brand-sub">OpenTelemetry semantic convention checker</span>
        </Link>
        <h1>When the sources disagree.</h1>
        <p className="lede">
          Attrition&apos;s Knowledge Base holds two kinds of source: the attribute registry, imported from every spec release, and the official
          migration guides. When a build finds them saying different things about the same name, Sanity raises a conflict with both claims side by
          side. Each one below was decided by a person, and the decision is now a standing instruction that every future build follows.
        </p>
        <nav className="links">
          <Link href="/">Scanner</Link>
          <a href="https://github.com/vignesh2027/attrition/blob/main/kb/DECISIONS.md">Decision log in the repo</a>
          <a href="https://github.com/vignesh2027/attrition/tree/main/kb">Knowledge Base sources</a>
        </nav>
      </header>

      {!data && <p className="error">The Knowledge Base is not reachable right now. The decision log in the repository has the same content.</p>}

      {data && (
        <>
          <section className="stats decisions-stats">
            <div className="stat warn">
              <strong>{data.decisions.length}</strong>
              <span>conflicts raised by the build</span>
            </div>
            <div className="stat ok">
              <strong>{data.decisions.filter((d) => d.chosen !== null).length}</strong>
              <span>decided by a person</span>
            </div>
            <div className="stat">
              <strong>{data.instructions.length}</strong>
              <span>standing instructions</span>
            </div>
            <div className="stat">
              <strong>{data.otherIssues}</strong>
              <span>other build issues, all applied</span>
            </div>
          </section>

          <ol className="decisions">
            {data.decisions.map((d) => (
              <li key={d.id} className="panel decision">
                <div className="panel-head">
                  <span>Conflict</span>
                  <span className="muted">
                    {d.severity} · {d.status} · {d.id.replace('issue.', '')}
                  </span>
                </div>
                <div className="decision-body">
                  <p>{d.issue}</p>
                  <div className="sides">
                    {d.sides.map((s, i) => (
                      <div key={i} className={`side ${d.chosen === i ? 'chosen' : ''}`}>
                        <span className="side-tag">{d.chosen === i ? 'Ground truth' : `Claim ${i + 1}`}</span>
                        <p>{s.claim}</p>
                        <p className="muted small">
                          {s.entryPaths?.length ? <>Entry: {s.entryPaths.map((p) => <code key={p}>{p} </code>)}</> : null}
                          {s.sourceIds?.length ? <>Backed by {s.sourceIds.length} source document{s.sourceIds.length > 1 ? 's' : ''}</> : null}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              </li>
            ))}
          </ol>

          <section className="panel instructions">
            <div className="panel-head">
              <span>Standing instructions</span>
              <span className="muted">carried into every future build</span>
            </div>
            <ul>
              {data.instructions.map((i) => (
                <li key={i.id}>
                  {i.statement} <span className="muted small">({i.origin}, scoped to {i.sourceCount} sources)</span>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}

      <footer className="foot">
        <p>
          Why these conflicts are real: the registry stops listing a name once it is gone, so it says nothing about a replacement, while the
          migration guides were written for people moving off that name. Attrition uses the registry for verdicts and the guides for what to do
          next, and shows both in every scan.
        </p>
      </footer>
    </main>
  )
}
