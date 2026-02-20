import Anthropic from "@anthropic-ai/sdk";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FRAMEWORK_PATH = join(__dirname, "..", "framework-prompt.md");

let frameworkCache = null;

async function loadFramework() {
  if (!frameworkCache) {
    frameworkCache = await readFile(FRAMEWORK_PATH, "utf-8");
  }
  return frameworkCache;
}

function buildUserMessage(text, { fullRewrite = false } = {}) {
  let msg = `Analyze the following communications text using the full framework.\n\n---\n\n${text}\n\n---\n\n`;
  if (fullRewrite) {
    msg += "Include a FULL REWRITE (Section 4) in addition to the standard analysis.";
  } else {
    msg += "Provide Sections 1-3 and 5 (skip the full rewrite unless it would be especially illustrative).";
  }
  return msg;
}

export async function analyzeStream(text, { fullRewrite = false } = {}) {
  const client = new Anthropic();
  const systemPrompt = await loadFramework();

  return client.messages.stream({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 8192,
    system: systemPrompt,
    messages: [
      { role: "user", content: buildUserMessage(text, { fullRewrite }) },
    ],
  });
}

export async function analyze(text, { fullRewrite = false } = {}) {
  const stream = await analyzeStream(text, { fullRewrite });
  const response = await stream.finalMessage();
  return response.content[0].text;
}
