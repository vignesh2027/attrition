"""Attrition from the terminal: a small tool-calling agent in plain Python.

The web app uses the Vercel AI SDK. This file shows the same Sanity Context
endpoints work from any stack: it connects to both MCP servers with the
official Python MCP SDK, hands their tools to a model over the OpenAI
compatible API, and runs the tool loop itself.

    python ask.py "What replaced net.peer.name on a server span?"
    python ask.py --verbose "How do I dual-emit database attributes?"

Needs SANITY_ORGANIZATION_TOKEN (Context Viewer) and GROQ_API_KEY in the
environment or in ../.env.
"""

import argparse
import asyncio
import json
import os
import pathlib
import sys
from contextlib import AsyncExitStack

from dotenv import load_dotenv
from mcp.client.session import ClientSession
from mcp.client.streamable_http import create_mcp_http_client, streamable_http_client
from openai import OpenAI

load_dotenv(pathlib.Path(__file__).resolve().parent.parent / ".env")

DATASET_MCP = os.getenv(
    "SANITY_CONTEXT_MCP_URL", "https://api.sanity.io/v1/context/organizations/oc2g3x7ee/mcp/attrition"
)
KB_MCP = os.getenv("SANITY_KB_MCP_URL", "https://api.sanity.io/v1/context/organizations/oc2g3x7ee/mcp/attrition-kb")
KB_ID = os.getenv("SANITY_KB_ID", "kbI5ncVyqDpc")
MODEL = os.getenv("GROQ_MODEL", "openai/gpt-oss-120b")
MAX_STEPS = 5
MAX_TOOL_CHARS = 3500
# House style: no em or en dashes, and plain parentheses for citations.
CLEAN = str.maketrans({"\u2014": "-", "\u2013": "-", "\u3010": " (", "\u3011": ")"})

SYSTEM = f"""You answer questions about OpenTelemetry semantic conventions: attribute keys, metric names and event names.
Verdicts, replacement names, units and releases come only from groq_query on the Sanity dataset. Types attribute, metric
and event share these fields: {{key, status, stability, unit, lastSeenIn, "src": source.url,
deprecation{{verdict, deprecatedIn, note, unitChange, replacements[]{{key, when}}}}}}.
status "dropped" means the name left the spec with no deprecation entry. For a dropped name you MUST then call
knowledge_base_search with the name and knowledge_base_read the best hit, because only a migration guide records a replacement.
Migration guidance comes from the Knowledge Base {KB_ID}: knowledge_base_search, then knowledge_base_read
(use the exact paths that knowledge_base_search returns).
Never invent a name or a release. SPAN_KIND_DEPENDENT answers depend on client vs server spans.
Be brief. Cite (Sanity dataset) or the Knowledge Base path. Never use em dashes or en dashes."""

# The only tools the model gets, with short descriptions to save tokens.
KEEP = {
    "groq_query": "Run a GROQ query on the OpenTelemetry attribute dataset. Always project fields.",
    "knowledge_base_search": "Keyword search the migration guide Knowledge Base. Returns entry paths.",
    "knowledge_base_read": "Read Knowledge Base entries by path.",
}


async def connect(stack: AsyncExitStack, url: str, token: str) -> ClientSession:
    http = await stack.enter_async_context(create_mcp_http_client(headers={"Authorization": f"Bearer {token}"}))
    streams = await stack.enter_async_context(streamable_http_client(url, http_client=http))
    session = await stack.enter_async_context(ClientSession(streams[0], streams[1]))
    await session.initialize()
    return session


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("question")
    parser.add_argument("--verbose", action="store_true", help="print each tool call")
    args = parser.parse_args()

    async with AsyncExitStack() as stack:
        sessions: dict[str, ClientSession] = {}
        tools = []
        token = os.environ["SANITY_ORGANIZATION_TOKEN"]
        endpoints = [(DATASET_MCP, token), (KB_MCP, token)]
        for url, token in endpoints:
            session = await connect(stack, url, token)
            for t in (await session.list_tools()).tools:
                if t.name in KEEP:
                    sessions[t.name] = session
                    tools.append(
                        {
                            "type": "function",
                            "function": {"name": t.name, "description": KEEP[t.name], "parameters": t.input_schema},
                        }
                    )

        client = OpenAI(api_key=os.environ["GROQ_API_KEY"], base_url="https://api.groq.com/openai/v1")
        messages = [{"role": "system", "content": SYSTEM}, {"role": "user", "content": args.question}]

        for _ in range(MAX_STEPS):
            reply = client.chat.completions.create(model=MODEL, messages=messages, tools=tools).choices[0].message
            if not reply.tool_calls:
                print(reply.content.translate(CLEAN))
                return 0
            messages.append(reply.model_dump(exclude_none=True))
            for call in reply.tool_calls:
                call_args = json.loads(call.function.arguments or "{}")
                if args.verbose:
                    print(f"[{call.function.name}] {json.dumps(call_args)[:160]}", file=sys.stderr)
                result = await sessions[call.function.name].call_tool(call.function.name, call_args)
                text = "\n".join(getattr(c, "text", "") for c in result.content)[:MAX_TOOL_CHARS]
                messages.append({"role": "tool", "tool_call_id": call.id, "content": text})
        print("Stopped after the step limit without a final answer.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
