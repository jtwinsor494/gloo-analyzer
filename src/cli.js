#!/usr/bin/env node

import { readFile, access } from "node:fs/promises";
import { analyzeStream, analyze } from "./analyzer.js";

const HELP = `
Gloo Communications Analyzer — CLI

Usage:
  node src/cli.js <file>           Analyze a text file
  node src/cli.js --rewrite <file> Analyze and include a full rewrite
  echo "text" | node src/cli.js -  Read from stdin
  node src/cli.js --help           Show this help

Environment:
  ANTHROPIC_API_KEY  Required. Your Anthropic API key.

Examples:
  node src/cli.js press-release.txt
  node src/cli.js --rewrite earnings-script.txt
  cat memo.txt | node src/cli.js -
`.trim();

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h") || args.length === 0) {
    console.log(HELP);
    process.exit(0);
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("Error: ANTHROPIC_API_KEY environment variable is not set.");
    console.error("  export ANTHROPIC_API_KEY=sk-ant-...");
    process.exit(1);
  }

  const fullRewrite = args.includes("--rewrite") || args.includes("-r");
  const fileArg = args.filter((a) => !a.startsWith("-")).pop() || (args.includes("-") ? "-" : null);

  let text;
  if (fileArg === "-") {
    process.stderr.write("Reading from stdin...\n");
    text = await readStdin();
  } else if (fileArg) {
    try {
      await access(fileArg);
    } catch {
      console.error(`Error: File not found: ${fileArg}`);
      process.exit(1);
    }
    text = await readFile(fileArg, "utf-8");
  } else {
    console.error("Error: No input file specified.");
    console.log(HELP);
    process.exit(1);
  }

  if (!text.trim()) {
    console.error("Error: Input is empty.");
    process.exit(1);
  }

  process.stderr.write(
    `\nAnalyzing ${text.length} characters${fullRewrite ? " (with full rewrite)" : ""}...\n\n`
  );

  const stream = await analyzeStream(text, { fullRewrite });

  stream.on("text", (chunk) => {
    process.stdout.write(chunk);
  });

  await stream.finalMessage();
  process.stdout.write("\n");
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
