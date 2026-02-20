import express from "express";
import { analyzeStream } from "./analyzer.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = parseInt(process.env.RATE_LIMIT || "10", 10); // requests per IP per minute

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "500kb" }));
app.use(express.urlencoded({ extended: true, limit: "500kb" }));

// --- Simple in-memory rate limiter ---

const hits = new Map();

function rateLimit(req, res, next) {
  const ip = req.ip;
  const now = Date.now();
  const record = hits.get(ip) || { count: 0, resetAt: now + RATE_WINDOW_MS };
  if (now > record.resetAt) {
    record.count = 0;
    record.resetAt = now + RATE_WINDOW_MS;
  }
  record.count++;
  hits.set(ip, record);
  if (record.count > RATE_MAX) {
    return res.status(429).json({ error: "Rate limit exceeded. Try again in a minute." });
  }
  next();
}

// Clean up stale entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of hits) {
    if (now > record.resetAt) hits.delete(ip);
  }
}, 300_000).unref();

// --- Web UI ---

app.get("/", (_req, res) => {
  res.send(HTML);
});

// --- Health check for deployment platforms ---

app.get("/health", (_req, res) => {
  res.json({ status: "ok", apiKey: !!process.env.ANTHROPIC_API_KEY });
});

// --- Streaming analysis endpoint ---

app.post("/api/analyze", rateLimit, async (req, res) => {
  const { text, fullRewrite } = req.body;
  if (!text || !text.trim()) {
    return res.status(400).json({ error: "text is required" });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY is not set" });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  try {
    const stream = await analyzeStream(text, { fullRewrite: !!fullRewrite });

    stream.on("text", (chunk) => {
      res.write(`data: ${JSON.stringify({ text: chunk })}\n\n`);
    });

    stream.on("end", () => {
      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      res.end();
    });

    stream.on("error", (err) => {
      res.write(
        `data: ${JSON.stringify({ error: err.message || "Stream error" })}\n\n`
      );
      res.end();
    });

    req.on("close", () => {
      stream.abort();
    });
  } catch (err) {
    res.write(
      `data: ${JSON.stringify({ error: err.message || "Analysis failed" })}\n\n`
    );
    res.end();
  }
});

app.listen(PORT, () => {
  console.log(`Gloo Analyzer running at http://localhost:${PORT}`);
});

// --- Inline HTML ---

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Gloo Communications Analyzer</title>
<style>
  :root {
    --bg: #0f1117;
    --surface: #1a1d27;
    --surface2: #22253a;
    --border: #2a2d3a;
    --text: #e4e4e7;
    --muted: #9ca3af;
    --accent: #6366f1;
    --accent-hover: #818cf8;
    --green: #22c55e;
    --yellow: #eab308;
    --red: #ef4444;
    --orange: #f97316;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: var(--bg);
    color: var(--text);
    line-height: 1.6;
    min-height: 100vh;
  }
  .container { max-width: 1000px; margin: 0 auto; padding: 2rem 1.5rem; }
  header { text-align: center; margin-bottom: 2rem; padding-bottom: 1.5rem; border-bottom: 1px solid var(--border); }
  header h1 { font-size: 1.75rem; font-weight: 700; letter-spacing: -0.02em; }
  header .subtitle { color: var(--muted); margin-top: 0.25rem; font-size: 0.95rem; }
  header .badges { display: flex; justify-content: center; gap: 0.5rem; margin-top: 0.75rem; flex-wrap: wrap; }
  .badge { font-size: 0.7rem; padding: 0.2rem 0.6rem; border-radius: 999px; font-weight: 600; background: var(--surface2); color: var(--muted); border: 1px solid var(--border); }

  .input-section { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 1.5rem; margin-bottom: 1.5rem; }
  .input-label { display: block; font-weight: 600; margin-bottom: 0.5rem; font-size: 0.9rem; }
  textarea {
    width: 100%; min-height: 220px; background: var(--bg); border: 1px solid var(--border);
    border-radius: 8px; padding: 1rem; color: var(--text); font-family: inherit;
    font-size: 0.95rem; resize: vertical; line-height: 1.6;
  }
  textarea:focus { outline: none; border-color: var(--accent); }
  .char-count { text-align: right; font-size: 0.75rem; color: var(--muted); margin-top: 0.25rem; }
  .controls { display: flex; align-items: center; gap: 1rem; margin-top: 1rem; flex-wrap: wrap; }
  .checkbox-label { display: flex; align-items: center; gap: 0.5rem; font-size: 0.9rem; color: var(--muted); cursor: pointer; user-select: none; }
  .checkbox-label input { accent-color: var(--accent); width: 16px; height: 16px; }
  button {
    background: var(--accent); color: #fff; border: none; border-radius: 8px;
    padding: 0.65rem 1.5rem; font-size: 0.95rem; font-weight: 600; cursor: pointer;
    transition: background 0.15s;
  }
  button:hover { background: var(--accent-hover); }
  button:disabled { opacity: 0.5; cursor: not-allowed; }

  .output-section { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 1.5rem; display: none; }
  .output-section.visible { display: block; }
  .output-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem; }
  .output-header h2 { font-size: 1.1rem; }
  .status { font-size: 0.8rem; padding: 0.25rem 0.75rem; border-radius: 999px; font-weight: 600; }
  .status.streaming { background: rgba(99,102,241,0.15); color: var(--accent-hover); }
  .status.done { background: rgba(34,197,94,0.15); color: var(--green); }
  .status.error { background: rgba(239,68,68,0.15); color: var(--red); }

  #output {
    font-size: 0.9rem; line-height: 1.8; max-height: 75vh; overflow-y: auto; padding-right: 0.5rem;
  }
  #output h1 { font-size: 1.3rem; font-weight: 700; margin: 1.5em 0 0.5em; color: var(--accent-hover); border-bottom: 1px solid var(--border); padding-bottom: 0.3em; }
  #output h2 { font-size: 1.15rem; font-weight: 700; margin: 1.3em 0 0.4em; color: var(--accent-hover); }
  #output h3 { font-size: 1rem; font-weight: 600; margin: 1.1em 0 0.3em; color: var(--text); }
  #output p { margin: 0.5em 0; }
  #output strong { color: #fff; }
  #output em { color: var(--yellow); font-style: italic; }
  #output ul, #output ol { margin: 0.5em 0 0.5em 1.5em; }
  #output li { margin: 0.25em 0; }
  #output code { background: var(--surface2); padding: 0.15em 0.4em; border-radius: 4px; font-size: 0.85em; font-family: "SF Mono", "Fira Code", monospace; }
  #output blockquote { border-left: 3px solid var(--accent); padding: 0.5em 1em; margin: 0.75em 0; background: rgba(99,102,241,0.05); border-radius: 0 6px 6px 0; }
  #output table { border-collapse: collapse; margin: 0.75em 0; width: 100%; font-size: 0.85rem; }
  #output th, #output td { border: 1px solid var(--border); padding: 0.5em 0.75em; text-align: left; }
  #output th { background: var(--surface2); font-weight: 600; }
  #output hr { border: none; border-top: 1px solid var(--border); margin: 1.5em 0; }

  .cursor { display: inline-block; width: 2px; height: 1.1em; background: var(--accent); animation: blink 0.8s step-end infinite; vertical-align: text-bottom; margin-left: 1px; }
  @keyframes blink { 50% { opacity: 0; } }

  .copy-btn {
    background: var(--surface2); color: var(--muted); border: 1px solid var(--border);
    border-radius: 6px; padding: 0.35rem 0.75rem; font-size: 0.8rem; cursor: pointer;
    transition: all 0.15s;
  }
  .copy-btn:hover { color: var(--text); border-color: var(--accent); background: var(--surface); }

  .how-it-works { margin-top: 2rem; padding-top: 1.5rem; border-top: 1px solid var(--border); }
  .how-it-works h3 { font-size: 0.95rem; color: var(--muted); margin-bottom: 0.75rem; }
  .dims { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 0.5rem; }
  .dim { background: var(--surface2); border: 1px solid var(--border); border-radius: 8px; padding: 0.6rem 0.8rem; font-size: 0.8rem; }
  .dim .name { font-weight: 600; color: var(--text); }
  .dim .desc { color: var(--muted); }
</style>
</head>
<body>
<div class="container">
  <header>
    <h1>Gloo Communications Analyzer</h1>
    <p class="subtitle">AI-native language framework &mdash; score, diagnose, and rewrite any piece of Gloo communications</p>
    <div class="badges">
      <span class="badge">7 Dimensions</span>
      <span class="badge">4 Diagnostic Tells</span>
      <span class="badge">Line-by-Line Rewrites</span>
      <span class="badge">Score Delta</span>
    </div>
  </header>

  <div class="input-section">
    <label class="input-label" for="input">Paste communications text</label>
    <textarea id="input" placeholder="Paste a press release, earnings script, marketing copy, investor materials, or internal memo here..."></textarea>
    <div class="char-count"><span id="char-count">0</span> characters</div>
    <div class="controls">
      <button id="analyze-btn" onclick="runAnalysis()">Analyze</button>
      <label class="checkbox-label">
        <input type="checkbox" id="rewrite-check">
        Include full rewrite
      </label>
    </div>
  </div>

  <div class="output-section" id="output-section">
    <div class="output-header">
      <h2>Analysis</h2>
      <div style="display:flex;gap:0.5rem;align-items:center;">
        <span class="status" id="status"></span>
        <button class="copy-btn" id="copy-btn" onclick="copyOutput()" style="display:none;">Copy</button>
      </div>
    </div>
    <div id="output"></div>
  </div>

  <div class="how-it-works">
    <h3>The Seven Dimensions (scored 1-5 each, composite 7-35)</h3>
    <div class="dims">
      <div class="dim"><span class="name">D1</span> <span class="desc">Self-Description</span></div>
      <div class="dim"><span class="name">D2</span> <span class="desc">Unit of Value</span></div>
      <div class="dim"><span class="name">D3</span> <span class="desc">Competitive Frame</span></div>
      <div class="dim"><span class="name">D4</span> <span class="desc">CEO/Founder Voice</span></div>
      <div class="dim"><span class="name">D5</span> <span class="desc">Temporal Orientation</span></div>
      <div class="dim"><span class="name">D6</span> <span class="desc">Financial Narrative</span></div>
      <div class="dim"><span class="name">D7</span> <span class="desc">Organizational Language</span></div>
    </div>
  </div>
</div>

<script>
document.getElementById("input").addEventListener("input", e => {
  document.getElementById("char-count").textContent = e.target.value.length;
});

function copyOutput() {
  const text = rawOutput;
  navigator.clipboard.writeText(text).then(() => {
    const btn = document.getElementById("copy-btn");
    btn.textContent = "Copied!";
    setTimeout(() => btn.textContent = "Copy", 1500);
  });
}

// Minimal markdown renderer (no external deps)
function renderMd(src) {
  let html = src
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    // headings
    .replace(/^### (.+)$/gm, "<h3>$1</h3>")
    .replace(/^## (.+)$/gm, "<h2>$1</h2>")
    .replace(/^# (.+)$/gm, "<h1>$1</h1>")
    // hr
    .replace(/^---$/gm, "<hr>")
    // bold + italic
    .replace(/\\*\\*\\*(.+?)\\*\\*\\*/g, "<strong><em>$1</em></strong>")
    .replace(/\\*\\*(.+?)\\*\\*/g, "<strong>$1</strong>")
    .replace(/\\*(.+?)\\*/g, "<em>$1</em>")
    // inline code
    .replace(/\`([^\`]+)\`/g, "<code>$1</code>")
    // blockquote
    .replace(/^&gt; (.+)$/gm, "<blockquote>$1</blockquote>")
    // unordered list items
    .replace(/^- (.+)$/gm, "<li>$1</li>")
    // paragraphs: double newlines
    .replace(/\\n\\n/g, "</p><p>")
    // single newlines in list context keep as-is, others become <br>
    .replace(/\\n/g, "<br>");
  // wrap consecutive <li> in <ul>
  html = html.replace(/(<li>.*?<\\/li>(?:<br>)?)+/g, (m) => "<ul>" + m.replace(/<br>/g, "") + "</ul>");
  return "<p>" + html + "</p>";
}

let rawOutput = "";

async function runAnalysis() {
  const text = document.getElementById("input").value.trim();
  if (!text) return;

  const btn = document.getElementById("analyze-btn");
  const section = document.getElementById("output-section");
  const output = document.getElementById("output");
  const status = document.getElementById("status");
  const copyBtn = document.getElementById("copy-btn");
  const fullRewrite = document.getElementById("rewrite-check").checked;

  btn.disabled = true;
  copyBtn.style.display = "none";
  section.classList.add("visible");
  output.innerHTML = '<span class="cursor"></span>';
  status.textContent = "Analyzing...";
  status.className = "status streaming";
  rawOutput = "";

  // Scroll output into view
  section.scrollIntoView({ behavior: "smooth", block: "start" });

  try {
    const res = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, fullRewrite }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Request failed" }));
      throw new Error(err.error || "Request failed with status " + res.status);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        try {
          const data = JSON.parse(line.slice(6));
          if (data.error) {
            status.textContent = "Error";
            status.className = "status error";
            output.innerHTML = "<p style=\\"color:var(--red)\\">Error: " + data.error + "</p>";
            btn.disabled = false;
            return;
          }
          if (data.done) {
            status.textContent = "Complete";
            status.className = "status done";
            btn.disabled = false;
            copyBtn.style.display = "inline-block";
            output.innerHTML = renderMd(rawOutput);
            return;
          }
          if (data.text) {
            rawOutput += data.text;
            // During streaming, show plain text with cursor for speed
            output.textContent = rawOutput;
            const cursorEl = document.createElement("span");
            cursorEl.className = "cursor";
            output.appendChild(cursorEl);
            output.scrollTop = output.scrollHeight;
          }
        } catch {}
      }
    }

    // Stream ended
    status.textContent = "Complete";
    status.className = "status done";
    btn.disabled = false;
    copyBtn.style.display = "inline-block";
    output.innerHTML = renderMd(rawOutput);
  } catch (err) {
    status.textContent = "Error";
    status.className = "status error";
    output.innerHTML = "<p style=\\"color:var(--red)\\">" + err.message + "</p>";
    btn.disabled = false;
  }
}
</script>
</body>
</html>`;
