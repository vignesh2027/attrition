# Knowledge Base: OpenTelemetry semconv migrations

Knowledge Base `kbI5ncVyqDpc` in Sanity organization `oc2g3x7ee`, served through the
organization Context MCP endpoint `attrition-kb`.

It holds 107 source documents, well inside the 150 document beta budget:

| Source | Count | Why it is here |
| --- | --- | --- |
| Dataset slice of project `y9raau23` | 98 | Deprecated attributes in the namespaces most instrumentation touches: `db`, `http`, `net`, `rpc`, `messaging`, `code`, `message`. `gen_ai` moves are left out; the dataset answers those. |
| Official migration guides at v1.44.0 | 5 | HTTP, database, RPC, code attributes, and version selection (`OTEL_SEMCONV_STABILITY_OPT_IN`). These carry what the registry does not: behaviour changes, privacy notes, dual emit. |
| Older spec pages | 2 | The HTTP conventions from specification v1.20.0 and the database spans page from semconv v1.24.0. Both still use the retired names. The build filed them as `legacy_snapshots`, apart from the current guidance. |

The files in `sources/` are copied unchanged from
[open-telemetry/semantic-conventions](https://github.com/open-telemetry/semantic-conventions) and
[open-telemetry/opentelemetry-specification](https://github.com/open-telemetry/opentelemetry-specification),
both Apache License 2.0.

Rebuild from scratch with `./build-kb.sh` (needs `npx sanity login` as an organization admin).
