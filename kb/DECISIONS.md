# Knowledge Base decisions

The build of Knowledge Base `kbI5ncVyqDpc` raised four conflicts between the dataset slice (registry facts) and the official migration guides. Each was resolved by a person on 3 October 2026 and became a standing instruction that later builds follow. The live list is at https://attrition-otel.vercel.app/decisions.

| Conflict | Claim A | Claim B | Ground truth | Why |
| --- | --- | --- | --- | --- |
| `http.resend_count` replacement | Guide: migrates to `http.request.resend_count` | Dataset: dropped after v1.22.0 with no deprecation entry and no replacement | Guide | The registry stops listing a name once it is gone, so its silence is not a "no replacement". The guide names one. |
| `http.resend_count` status | Dataset: dropped silently | Guide: renamed to `http.request.resend_count` | Guide | Same fact, raised from the other entry. |
| `http.server.duration` | Dataset: dropped in v1.22.0 with no replacement | Guide: renamed to `http.server.request.duration`, unit ms to s | Guide | The metric did leave the registry with no entry; the guide is the only record of where it went, and of the unit change. |
| RPC size and count metrics timeline | Entry: removed in v1.38.0 to v1.40.0 | Sources: deprecated in v1.38.0 to v1.40.0, verdict REMOVED as of v1.44.0 | Sources | The entry summary blurred deprecation and removal; the source documents are precise. |

The same build also raised one coverage gap (".NET WCF" named in the RPC guide but in no entry), four update-required issues for pages that still contradicted the decisions, and four stale entries left over from an earlier source swap. All were applied through `client.context.issues.apply()`.

Attrition reflects these decisions in code as well: a `DROPPED` name takes its replacement only from a guide row, and the scan says so on the finding.
