import { mkdir, readFile, readdir, writeFile, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

type ClaimDraft = {
  id: string;
  claim_text: string;
  evidence: string;
  caveat: string;
  counterargument: string;
  confidence: number;
  related_hypotheses: string[];
};

type MemoryUpdateDraft = {
  id: string;
  target_type: "claim" | "hypothesis" | "trace";
  target_file: string;
  action:
    | "add_claim"
    | "add_supporting_claim"
    | "add_opposing_claim"
    | "add_open_question"
    | "add_next_action"
    | "add_note";
  rationale: string;
  content: string;
  related_claim_ids: string[];
};

type ExtractionResult = {
  summary: string;
  claims: ClaimDraft[];
  proposed_memory_updates: MemoryUpdateDraft[];
  next_actions: string[];
};

type SourceRecord = {
  id: string;
  title: string;
  url: string | null;
  sourcePath: string;
  content: string;
};

type TraceRecord = {
  id: string;
  command: string;
  started_at: string;
  completed_at: string;
  source?: {
    id: string;
    title: string;
    url: string | null;
    path: string;
  };
  model?: string;
  prompt_file?: string;
  review_path?: string;
  input?: unknown;
  output?: unknown;
  accepted_updates?: number;
  rejected_updates?: number;
  errors: string[];
};

const ROOT = process.cwd();
const MEMORY_ROOT = path.join(ROOT, "research-memory");
const PROMPT_PATH = path.join(MEMORY_ROOT, "prompts", "extract-claims.md");
const DEFAULT_MODEL = "gpt-5.4-nano";

async function main() {
  await loadDotEnv();

  const [command, ...args] = process.argv.slice(2);

  if (command === "ingest") {
    await ingest(args);
    return;
  }

  if (command === "apply-review") {
    await applyReview(args);
    return;
  }

  printUsage();
  process.exitCode = 1;
}

async function loadDotEnv() {
  const envPath = path.join(ROOT, ".env");

  if (!existsSync(envPath)) {
    return;
  }

  const content = await readFile(envPath, "utf8");

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();

    if (!line || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");

    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");

    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

async function ingest(args: string[]) {
  const sourceArg = args.find((arg) => !arg.startsWith("--"));
  const useMock = args.includes("--mock");

  if (!sourceArg) {
    throw new Error("source Markdown path or URL is required.");
  }

  await ensureMemoryDirs();

  const startedAt = nowIso();
  const source = await loadSource(sourceArg);
  const hypotheses = await loadHypotheses();
  const prompt = await readFile(PROMPT_PATH, "utf8");
  const model = process.env.OPENAI_MODEL || DEFAULT_MODEL;
  const traceId = `${compactTimestamp(startedAt)}-${source.id}`;

  const trace: TraceRecord = {
    id: traceId,
    command: "ingest",
    started_at: startedAt,
    completed_at: "",
    source: {
      id: source.id,
      title: source.title,
      url: source.url,
      path: source.sourcePath,
    },
    model,
    prompt_file: relativePath(PROMPT_PATH),
    input: {
      source_path: source.sourcePath,
      hypothesis_count: hypotheses.length,
      mock: useMock,
    },
    errors: [],
  };

  try {
    const result = useMock
      ? createMockExtraction(source, hypotheses)
      : await extractWithOpenAI({ source, hypotheses, prompt, model });
    const reviewPath = await writeReview(source, result, traceId);

    trace.review_path = relativePath(reviewPath);
    trace.output = result;
    trace.completed_at = nowIso();
    await writeTrace(trace);

    console.log(`Review written: ${relativePath(reviewPath)}`);
    console.log(`Trace written: research-memory/traces/${trace.id}.json`);
  } catch (error) {
    trace.errors.push(error instanceof Error ? error.message : String(error));
    trace.completed_at = nowIso();
    await writeTrace(trace);
    throw error;
  }
}

async function applyReview(args: string[]) {
  const reviewArg = args.find((arg) => !arg.startsWith("--"));

  if (!reviewArg) {
    throw new Error("review Markdown path is required.");
  }

  await ensureMemoryDirs();

  const startedAt = nowIso();
  const reviewPath = path.resolve(ROOT, reviewArg);
  const review = await readFile(reviewPath, "utf8");
  const metadata = parseFrontMatter(review);
  const blocks = parseReviewBlocks(review);
  const approved = blocks.filter((block) => block.status === "approved");
  const rejected = blocks.filter((block) => block.status === "rejected");
  const sourceId = metadata.source_id || "unknown-source";
  const traceId = `${compactTimestamp(startedAt)}-apply-${sourceId}`;

  const trace: TraceRecord = {
    id: traceId,
    command: "apply-review",
    started_at: startedAt,
    completed_at: "",
    review_path: relativePath(reviewPath),
    input: {
      review_path: relativePath(reviewPath),
      approved: approved.map((block) => block.id),
      rejected: rejected.map((block) => block.id),
      pending: blocks.filter((block) => block.status === "pending").map((block) => block.id),
    },
    accepted_updates: approved.length,
    rejected_updates: rejected.length,
    errors: [],
  };

  for (const block of approved) {
    if (block.type === "claim") {
      await saveApprovedClaim(block, metadata);
    }

    if (block.type === "hypothesis_update") {
      await appendHypothesisUpdate(block);
    }
  }

  await appendRejectedUpdatesTrace(rejected, metadata, traceId);
  trace.completed_at = nowIso();
  await writeTrace(trace);

  console.log(`Approved updates applied: ${approved.length}`);
  console.log(`Rejected updates recorded: ${rejected.length}`);
  console.log(`Trace written: research-memory/traces/${trace.id}.json`);
}

async function ensureMemoryDirs() {
  const dirs = [
    "sources/inbox",
    "sources/processed",
    "claims",
    "hypotheses",
    "decisions",
    "reviews",
    "traces",
    "prompts",
    "exports",
  ];

  await Promise.all(dirs.map((dir) => mkdir(path.join(MEMORY_ROOT, dir), { recursive: true })));
}

async function loadSource(sourceArg: string): Promise<SourceRecord> {
  if (isUrl(sourceArg)) {
    return fetchUrlSource(sourceArg);
  }

  const sourcePath = path.resolve(ROOT, sourceArg);
  const content = await readFile(sourcePath, "utf8");
  const metadata = parseFrontMatter(content);
  const title = metadata.title || firstHeading(content) || path.basename(sourcePath, path.extname(sourcePath));
  const url = metadata.url || null;
  const id = slugify(`${title}-${hash(content).slice(0, 8)}`);

  return {
    id,
    title,
    url,
    sourcePath: relativePath(sourcePath),
    content,
  };
}

async function fetchUrlSource(url: string): Promise<SourceRecord> {
  const response = await fetch(url, {
    headers: {
      "user-agent": "personal-research-memory-agent/0.1",
      accept: "text/html, text/plain;q=0.9",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch URL: ${response.status} ${response.statusText}`);
  }

  const html = await response.text();
  const title = extractTitle(html) || url;
  const text = htmlToText(html);
  const id = slugify(`${title}-${hash(url).slice(0, 8)}`);
  const sourcePath = path.join(MEMORY_ROOT, "sources", "inbox", `${id}.md`);
  const markdown = [
    "---",
    `title: ${yamlString(title)}`,
    `url: ${yamlString(url)}`,
    "source_type: url",
    `added_at: ${nowIso()}`,
    "---",
    "",
    `# ${title}`,
    "",
    `Source URL: ${url}`,
    "",
    "## Extracted Text",
    "",
    text,
    "",
  ].join("\n");

  await writeFile(sourcePath, markdown, "utf8");

  return {
    id,
    title,
    url,
    sourcePath: relativePath(sourcePath),
    content: markdown,
  };
}

async function loadHypotheses() {
  const hypothesesDir = path.join(MEMORY_ROOT, "hypotheses");
  const files = (await readdir(hypothesesDir)).filter((file) => file.endsWith(".md")).sort();

  return Promise.all(
    files.map(async (file) => {
      const filePath = path.join(hypothesesDir, file);
      return {
        file: `research-memory/hypotheses/${file}`,
        content: await readFile(filePath, "utf8"),
      };
    }),
  );
}

async function extractWithOpenAI({
  source,
  hypotheses,
  prompt,
  model,
}: {
  source: SourceRecord;
  hypotheses: { file: string; content: string }[];
  prompt: string;
  model: string;
}): Promise<ExtractionResult> {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY is not set. Set it in your environment, or run with --mock for local workflow testing.",
    );
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      instructions: prompt,
      input: buildExtractionInput(source, hypotheses),
      text: {
        format: {
          type: "json_schema",
          name: "research_memory_extraction",
          strict: true,
          schema: extractionSchema(),
        },
      },
    }),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(`OpenAI API error: ${response.status} ${JSON.stringify(data)}`);
  }

  const text = extractResponseText(data);

  if (!text) {
    throw new Error("OpenAI API response did not include output text.");
  }

  return JSON.parse(text) as ExtractionResult;
}

function buildExtractionInput(source: SourceRecord, hypotheses: { file: string; content: string }[]) {
  const hypothesisText = hypotheses.map((hypothesis) => `## ${hypothesis.file}\n\n${hypothesis.content}`).join("\n\n");
  const sourceText = source.content.slice(0, 30000);

  return [
    {
      role: "user",
      content: [
        {
          type: "input_text",
          text: [
            "# Source",
            `title: ${source.title}`,
            `url: ${source.url || ""}`,
            `path: ${source.sourcePath}`,
            "",
            sourceText,
            "",
            "# Existing Hypotheses",
            hypothesisText,
          ].join("\n"),
        },
      ],
    },
  ];
}

function extractionSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["summary", "claims", "proposed_memory_updates", "next_actions"],
    properties: {
      summary: { type: "string" },
      claims: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "id",
            "claim_text",
            "evidence",
            "caveat",
            "counterargument",
            "confidence",
            "related_hypotheses",
          ],
          properties: {
            id: { type: "string" },
            claim_text: { type: "string" },
            evidence: { type: "string" },
            caveat: { type: "string" },
            counterargument: { type: "string" },
            confidence: { type: "number" },
            related_hypotheses: {
              type: "array",
              items: { type: "string" },
            },
          },
        },
      },
      proposed_memory_updates: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "target_type", "target_file", "action", "rationale", "content", "related_claim_ids"],
          properties: {
            id: { type: "string" },
            target_type: { type: "string", enum: ["claim", "hypothesis", "trace"] },
            target_file: { type: "string" },
            action: {
              type: "string",
              enum: [
                "add_claim",
                "add_supporting_claim",
                "add_opposing_claim",
                "add_open_question",
                "add_next_action",
                "add_note",
              ],
            },
            rationale: { type: "string" },
            content: { type: "string" },
            related_claim_ids: {
              type: "array",
              items: { type: "string" },
            },
          },
        },
      },
      next_actions: {
        type: "array",
        items: { type: "string" },
      },
    },
  };
}

function createMockExtraction(
  source: SourceRecord,
  hypotheses: { file: string; content: string }[],
): ExtractionResult {
  const firstHypothesis = hypotheses[0]?.file || "research-memory/hypotheses/rag-still-matters.md";

  return {
    summary: `${source.title} をもとにしたモック要約です。OpenAI APIを呼ばずにCLIワークフローを確認するための出力です。`,
    claims: [
      {
        id: "claim-1",
        claim_text: "Contextを付与した検索結果は、RAGの回答品質改善に寄与する可能性がある。",
        evidence: `Source: ${source.title}`,
        caveat: "モック出力のため、実際の資料本文に基づく精査は未実施。",
        counterargument: "Context付与だけでは、検索対象の品質や評価設計の問題は解決しない。",
        confidence: 0.5,
        related_hypotheses: [firstHypothesis],
      },
    ],
    proposed_memory_updates: [
      {
        id: "update-1",
        target_type: "hypothesis",
        target_file: firstHypothesis,
        action: "add_supporting_claim",
        rationale: "RAGの改善余地に関するclaimとして関連するため。",
        content: "Contextを付与した検索結果は、RAGの回答品質改善に寄与する可能性がある。",
        related_claim_ids: ["claim-1"],
      },
    ],
    next_actions: ["実際のOpenAI API出力でclaim抽出品質を確認する。"],
  };
}

async function writeReview(source: SourceRecord, result: ExtractionResult, traceId: string) {
  const reviewPath = path.join(MEMORY_ROOT, "reviews", `${compactTimestamp(nowIso())}-${source.id}.review.md`);
  const lines: string[] = [
    "---",
    `source_id: ${source.id}`,
    `source_title: ${yamlString(source.title)}`,
    `source_url: ${yamlString(source.url || "")}`,
    `source_path: ${source.sourcePath}`,
    `trace_id: ${traceId}`,
    `created_at: ${nowIso()}`,
    "---",
    "",
    `# Review: ${source.title}`,
    "",
    "Edit `status=pending` to `status=approved` or `status=rejected` in each review block.",
    "",
    "## Summary",
    "",
    result.summary,
    "",
    "## Claim Reviews",
    "",
  ];

  for (const claim of result.claims) {
    lines.push(
      `<!-- review-block id=${claim.id} type=claim status=pending -->`,
      `### ${claim.id}`,
      "",
      `**Claim:** ${claim.claim_text}`,
      "",
      `**Evidence:** ${claim.evidence}`,
      "",
      `**Caveat:** ${claim.caveat}`,
      "",
      `**Counterargument:** ${claim.counterargument}`,
      "",
      `**Confidence:** ${claim.confidence}`,
      "",
      `**Related Hypotheses:** ${claim.related_hypotheses.join(", ")}`,
      "",
      "<!-- /review-block -->",
      "",
    );
  }

  lines.push("## Proposed Memory Updates", "");

  for (const update of result.proposed_memory_updates) {
    lines.push(
      `<!-- review-block id=${update.id} type=hypothesis_update status=pending -->`,
      `### ${update.id}`,
      "",
      `**Target:** ${update.target_file}`,
      "",
      `**Action:** ${update.action}`,
      "",
      `**Rationale:** ${update.rationale}`,
      "",
      `**Related Claims:** ${update.related_claim_ids.join(", ")}`,
      "",
      "**Content:**",
      "",
      update.content,
      "",
      "<!-- /review-block -->",
      "",
    );
  }

  lines.push("## Next Actions", "");

  for (const action of result.next_actions) {
    lines.push(`- ${action}`);
  }

  await writeFile(reviewPath, lines.join("\n"), "utf8");
  return reviewPath;
}

type ReviewBlock = {
  id: string;
  type: "claim" | "hypothesis_update";
  status: "pending" | "approved" | "rejected";
  body: string;
};

function parseReviewBlocks(review: string): ReviewBlock[] {
  const regex =
    /<!-- review-block id=([^ ]+) type=([^ ]+) status=(pending|approved|rejected) -->([\s\S]*?)<!-- \/review-block -->/g;
  const blocks: ReviewBlock[] = [];
  let match: RegExpExecArray | null;

  while ((match = regex.exec(review))) {
    blocks.push({
      id: match[1],
      type: match[2] as ReviewBlock["type"],
      status: match[3] as ReviewBlock["status"],
      body: match[4].trim(),
    });
  }

  return blocks;
}

async function saveApprovedClaim(block: ReviewBlock, metadata: Record<string, string>) {
  const sourceId = metadata.source_id || "unknown-source";
  const title = extractMarkdownField(block.body, "Claim") || block.id;
  const claimPath = path.join(MEMORY_ROOT, "claims", `${compactTimestamp(nowIso())}-${sourceId}-${block.id}.md`);
  const content = [
    "---",
    `source_id: ${sourceId}`,
    `source_title: ${yamlString(metadata.source_title || "")}`,
    `source_url: ${yamlString(metadata.source_url || "")}`,
    `review_id: ${block.id}`,
    `approved_at: ${nowIso()}`,
    "---",
    "",
    "# Claim",
    "",
    title,
    "",
    block.body,
    "",
  ].join("\n");

  await writeFile(claimPath, content, "utf8");
}

async function appendHypothesisUpdate(block: ReviewBlock) {
  const target = extractMarkdownField(block.body, "Target");
  const action = extractMarkdownField(block.body, "Action") || "add_note";
  const rationale = extractMarkdownField(block.body, "Rationale") || "";
  const content = extractContentSection(block.body);

  if (!target) {
    throw new Error(`Review block ${block.id} does not include a Target field.`);
  }

  const targetPath = path.resolve(ROOT, target);

  if (!targetPath.startsWith(ROOT) || !existsSync(targetPath)) {
    throw new Error(`Target hypothesis does not exist or is outside repository: ${target}`);
  }

  await appendFile(
    targetPath,
    [
      "",
      "## Approved Update",
      "",
      `- approved_at: ${nowIso()}`,
      `- review_block: ${block.id}`,
      `- action: ${action}`,
      `- rationale: ${rationale}`,
      "",
      content,
      "",
    ].join("\n"),
    "utf8",
  );
}

async function appendRejectedUpdatesTrace(
  rejected: ReviewBlock[],
  metadata: Record<string, string>,
  traceId: string,
) {
  if (rejected.length === 0) {
    return;
  }

  const rejectedPath = path.join(MEMORY_ROOT, "traces", `${traceId}-rejected-updates.json`);
  await writeFile(
    rejectedPath,
    JSON.stringify(
      {
        source_id: metadata.source_id || null,
        rejected_at: nowIso(),
        rejected_updates: rejected.map((block) => ({
          id: block.id,
          type: block.type,
          body: block.body,
        })),
      },
      null,
      2,
    ),
    "utf8",
  );
}

async function writeTrace(trace: TraceRecord) {
  await writeFile(path.join(MEMORY_ROOT, "traces", `${trace.id}.json`), JSON.stringify(trace, null, 2), "utf8");
}

function parseFrontMatter(markdown: string) {
  const match = markdown.match(/^---\n([\s\S]*?)\n---/);
  const metadata: Record<string, string> = {};

  if (!match) {
    return metadata;
  }

  for (const line of match[1].split("\n")) {
    const separatorIndex = line.indexOf(":");

    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim().replace(/^"(.*)"$/, "$1");
    metadata[key] = value;
  }

  return metadata;
}

function extractMarkdownField(body: string, field: string) {
  const match = body.match(new RegExp(`\\*\\*${escapeRegExp(field)}:\\*\\*\\s*(.+)`));
  return match?.[1]?.trim() || "";
}

function extractContentSection(body: string) {
  const match = body.match(/\*\*Content:\*\*\n\n([\s\S]*)$/);
  return match?.[1]?.trim() || "";
}

function extractResponseText(data: any): string {
  if (typeof data.output_text === "string") {
    return data.output_text;
  }

  for (const item of data.output || []) {
    for (const content of item.content || []) {
      if (typeof content.text === "string") {
        return content.text;
      }
    }
  }

  return "";
}

function firstHeading(markdown: string) {
  return markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() || "";
}

function extractTitle(html: string) {
  return decodeHtml(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, " ").trim() || "");
}

function htmlToText(html: string) {
  return decodeHtml(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<nav[\s\S]*?<\/nav>/gi, "")
      .replace(/<footer[\s\S]*?<\/footer>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  ).slice(0, 60000);
}

function decodeHtml(text: string) {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function isUrl(value: string) {
  return /^https?:\/\//.test(value);
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90);
}

function yamlString(value: string) {
  return JSON.stringify(value);
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function nowIso() {
  return new Date().toISOString();
}

function compactTimestamp(value: string) {
  return value.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function relativePath(filePath: string) {
  return path.relative(ROOT, filePath);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function printUsage() {
  console.log(`Usage:
  npm run ingest -- <source.md|https://example.com/article> [--mock]
  npm run apply-review -- <review.md>

Environment:
  OPENAI_API_KEY  Required unless --mock is used.
  OPENAI_MODEL    Optional. Defaults to ${DEFAULT_MODEL}.
`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
