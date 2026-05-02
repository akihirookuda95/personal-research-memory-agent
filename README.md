# personal-research-memory-agent

Personal Research Memory Agent is a private research workflow for turning sources into reviewed memory updates.

## MVP CLI workflow

The MVP is intentionally CLI-first.

```bash
npm run ingest -- https://www.anthropic.com/engineering/contextual-retrieval
```

The command:

1. fetches the source URL or reads a local Markdown file
2. loads existing hypotheses from `research-memory/hypotheses/`
3. asks OpenAI API to extract claims and proposed memory updates
4. writes a review Markdown file to `research-memory/reviews/`
5. writes an execution trace to `research-memory/traces/`

Set your API key in `.env` before running the real extraction:

```dotenv
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-5.4-nano
```

You can also use environment variables directly:

```bash
export OPENAI_API_KEY=...
```

For local workflow testing without calling OpenAI:

```bash
npm run ingest -- https://www.anthropic.com/engineering/contextual-retrieval --mock
```

## Reviewing updates

Open the generated review file and edit each review block:

```md
<!-- review-block id=claim-1 type=claim status=pending -->
```

Change `status=pending` to either:

- `status=approved`
- `status=rejected`

Then apply approved updates:

```bash
npm run apply-review -- research-memory/reviews/<generated>.review.md
```

Approved claim blocks are written to `research-memory/claims/`.
Approved hypothesis updates are appended to the target hypothesis file.
Rejected updates are not applied to memory, but are recorded in traces.
