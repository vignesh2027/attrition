# ask.py (Python)

A small tool-calling agent that uses the same two Sanity Context MCP endpoints as the web
app, written with the official Python MCP SDK and the OpenAI-compatible Groq API. It shows
the Context endpoints work from any stack, not just the Vercel AI SDK.

```sh
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python ask.py "My Python HTTP server sets http.target. What should it set now?"
.venv/bin/python ask.py --verbose "How do I dual-emit database attributes?"
```

It reads `SANITY_API_READ_TOKEN`, `GROQ_API_KEY` and, for the Knowledge Base,
`SANITY_ORGANIZATION_TOKEN` from the environment or from `../.env`.
