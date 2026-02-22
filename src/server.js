import express from "express";
import multer from "multer";
import { analyzeStream } from "./analyzer.js";
import { extractText } from "./fileParser.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = parseInt(process.env.RATE_LIMIT || "10", 10); // requests per IP per minute
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "500kb" }));
app.use(express.urlencoded({ extended: true, limit: "500kb" }));

// Multer for file uploads (memory storage — files stay in RAM)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter(_req, file, cb) {
    const allowed = [
      "application/vnd.openxmlformats-officedocument.presentationml.presentation", // .pptx
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",   // .docx
      "application/pdf",
      "text/plain",
      "text/markdown",
    ];
    // Also allow by extension for browsers that send generic MIME
    const ext = (file.originalname || "").split(".").pop().toLowerCase();
    const allowedExt = ["pptx", "pdf", "docx", "txt", "md"];
    if (allowed.includes(file.mimetype) || allowedExt.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${file.mimetype}. Upload PPTX, PDF, DOCX, TXT, or MD files.`));
    }
  },
});

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

// --- File upload + text extraction endpoint ---

app.post("/api/extract", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }
    const { text, format } = await extractText(req.file.buffer, {
      mimetype: req.file.mimetype,
      originalname: req.file.originalname,
    });
    res.json({ text, format, filename: req.file.originalname, chars: text.length });
  } catch (err) {
    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({ error: "File too large. Maximum size is 10 MB." });
      }
      return res.status(400).json({ error: err.message });
    }
    res.status(400).json({ error: err.message || "Failed to extract text from file" });
  }
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

// Multer error handler
app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError || err.message?.includes("Unsupported file type")) {
    return res.status(400).json({ error: err.message });
  }
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
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

  /* --- Page nav --- */
  .page-nav { display: flex; justify-content: center; gap: 0.5rem; margin-bottom: 1.5rem; }
  .page-nav-btn {
    padding: 0.5rem 1.5rem; font-size: 0.9rem; font-weight: 600; cursor: pointer;
    background: transparent; color: var(--muted); border: 1px solid var(--border);
    border-radius: 999px; transition: all 0.2s;
  }
  .page-nav-btn:hover { color: var(--text); border-color: var(--accent); }
  .page-nav-btn.active { background: var(--accent); color: #fff; border-color: var(--accent); }
  .page-view { display: none; }
  .page-view.active { display: block; }

  /* --- About page --- */
  .about-section { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 2rem; margin-bottom: 1.5rem; }
  .about-section h2 { font-size: 1.3rem; font-weight: 700; color: var(--accent-hover); margin-bottom: 1rem; }
  .about-section h3 { font-size: 1.05rem; font-weight: 600; color: var(--text); margin: 1.5rem 0 0.5rem; }
  .about-section p { color: var(--text); font-size: 0.92rem; line-height: 1.75; margin-bottom: 0.75rem; }
  .about-section .muted { color: var(--muted); }
  .about-section a { color: var(--accent-hover); text-decoration: none; }
  .about-section a:hover { text-decoration: underline; }
  .about-section ul { margin: 0.5rem 0 1rem 1.5rem; }
  .about-section li { color: var(--text); font-size: 0.92rem; line-height: 1.75; margin-bottom: 0.25rem; }
  .about-section li strong { color: #fff; }
  .timeline { position: relative; padding-left: 2rem; margin: 1.5rem 0; }
  .timeline::before { content: ''; position: absolute; left: 7px; top: 4px; bottom: 4px; width: 2px; background: var(--border); }
  .timeline-item { position: relative; margin-bottom: 1.25rem; }
  .timeline-item::before {
    content: ''; position: absolute; left: -2rem; top: 8px; width: 12px; height: 12px;
    border-radius: 50%; background: var(--accent); border: 2px solid var(--bg);
  }
  .timeline-item .step-label { font-size: 0.7rem; font-weight: 700; color: var(--accent-hover); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.15rem; }
  .timeline-item .step-text { font-size: 0.9rem; color: var(--text); line-height: 1.6; }
  .timeline-item .step-text .muted { color: var(--muted); }
  .callout {
    background: rgba(99,102,241,0.08); border: 1px solid rgba(99,102,241,0.2);
    border-radius: 10px; padding: 1.25rem 1.5rem; margin: 1.5rem 0;
  }
  .callout .callout-title { font-weight: 700; font-size: 0.9rem; color: var(--accent-hover); margin-bottom: 0.5rem; }
  .callout p { font-size: 0.88rem; margin-bottom: 0.5rem; }
  .tech-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 0.75rem; margin: 1rem 0; }
  .tech-card { background: var(--surface2); border: 1px solid var(--border); border-radius: 8px; padding: 0.75rem 1rem; }
  .tech-card .tech-name { font-weight: 600; font-size: 0.85rem; color: var(--text); }
  .tech-card .tech-desc { font-size: 0.78rem; color: var(--muted); margin-top: 0.15rem; }

  /* --- Tabs --- */
  .input-tabs { display: flex; gap: 0; margin-bottom: 0; }
  .tab-btn {
    padding: 0.6rem 1.25rem; font-size: 0.85rem; font-weight: 600; cursor: pointer;
    background: var(--surface2); color: var(--muted); border: 1px solid var(--border);
    border-bottom: none; border-radius: 8px 8px 0 0; transition: all 0.15s;
  }
  .tab-btn:hover { color: var(--text); }
  .tab-btn.active { background: var(--surface); color: var(--text); border-color: var(--border); position: relative; }
  .tab-btn.active::after { content: ''; position: absolute; bottom: -1px; left: 0; right: 0; height: 1px; background: var(--surface); }

  .input-section { background: var(--surface); border: 1px solid var(--border); border-radius: 0 12px 12px 12px; padding: 1.5rem; margin-bottom: 1.5rem; }
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

  /* --- File upload area --- */
  .tab-content { display: none; }
  .tab-content.active { display: block; }

  .upload-zone {
    border: 2px dashed var(--border); border-radius: 12px; padding: 2.5rem 1.5rem;
    text-align: center; cursor: pointer; transition: all 0.2s;
    background: var(--bg); position: relative;
  }
  .upload-zone:hover, .upload-zone.dragover {
    border-color: var(--accent); background: rgba(99,102,241,0.05);
  }
  .upload-zone input[type="file"] {
    position: absolute; inset: 0; opacity: 0; cursor: pointer;
  }
  .upload-icon { font-size: 2.5rem; margin-bottom: 0.5rem; }
  .upload-title { font-weight: 600; font-size: 1rem; margin-bottom: 0.25rem; }
  .upload-subtitle { color: var(--muted); font-size: 0.85rem; }
  .upload-formats { color: var(--muted); font-size: 0.75rem; margin-top: 0.75rem; }
  .upload-formats span { background: var(--surface2); padding: 0.15rem 0.5rem; border-radius: 4px; margin: 0 0.2rem; font-weight: 600; }

  .file-preview {
    display: none; background: var(--bg); border: 1px solid var(--border);
    border-radius: 8px; padding: 1rem; margin-top: 1rem;
  }
  .file-preview.visible { display: block; }
  .file-info { display: flex; align-items: center; gap: 0.75rem; margin-bottom: 0.75rem; }
  .file-icon { font-size: 1.5rem; }
  .file-name { font-weight: 600; font-size: 0.9rem; }
  .file-meta { color: var(--muted); font-size: 0.75rem; }
  .file-text-preview {
    max-height: 150px; overflow-y: auto; font-size: 0.8rem; color: var(--muted);
    background: var(--surface2); padding: 0.75rem; border-radius: 6px; white-space: pre-wrap;
    line-height: 1.5;
  }
  .file-remove {
    background: none; border: 1px solid var(--border); color: var(--muted); border-radius: 6px;
    padding: 0.3rem 0.75rem; font-size: 0.75rem; cursor: pointer; margin-left: auto;
  }
  .file-remove:hover { color: var(--red); border-color: var(--red); background: rgba(239,68,68,0.1); }
  .extracting { color: var(--accent-hover); font-size: 0.85rem; padding: 1rem 0; }

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

  @media (max-width: 600px) {
    .container { padding: 1rem; }
    .tab-btn { padding: 0.5rem 0.75rem; font-size: 0.8rem; }
  }
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

  <!-- Page navigation -->
  <div class="page-nav">
    <div class="page-nav-btn active" onclick="switchPage('analyzer')">Analyzer</div>
    <div class="page-nav-btn" onclick="switchPage('about')">About</div>
  </div>

  <!-- ============ ANALYZER PAGE ============ -->
  <div class="page-view active" id="page-analyzer">

  <!-- Tab buttons -->
  <div class="input-tabs">
    <div class="tab-btn active" onclick="switchTab('paste')">Paste Text</div>
    <div class="tab-btn" onclick="switchTab('upload')">Upload File</div>
  </div>

  <div class="input-section">
    <!-- Tab: Paste text -->
    <div class="tab-content active" id="tab-paste">
      <label class="input-label" for="input">Paste communications text</label>
      <textarea id="input" placeholder="Paste a press release, earnings script, marketing copy, investor materials, or internal memo here..."></textarea>
      <div class="char-count"><span id="char-count">0</span> characters</div>
    </div>

    <!-- Tab: Upload file -->
    <div class="tab-content" id="tab-upload">
      <label class="input-label">Upload a document</label>
      <div class="upload-zone" id="upload-zone">
        <input type="file" id="file-input" accept=".pptx,.pdf,.docx,.txt,.md" />
        <div class="upload-icon">&#128196;</div>
        <div class="upload-title">Drop a file here or click to browse</div>
        <div class="upload-subtitle">Google Slides? Export as PPTX first (File &rarr; Download &rarr; .pptx)</div>
        <div class="upload-formats">
          <span>PPTX</span> <span>PDF</span> <span>DOCX</span> <span>TXT</span> <span>MD</span>
        </div>
      </div>
      <div class="extracting" id="extracting" style="display:none;">Extracting text from file...</div>
      <div class="file-preview" id="file-preview">
        <div class="file-info">
          <span class="file-icon" id="file-icon">&#128196;</span>
          <div>
            <div class="file-name" id="file-name"></div>
            <div class="file-meta" id="file-meta"></div>
          </div>
          <button class="file-remove" onclick="removeFile()">Remove</button>
        </div>
        <div class="file-text-preview" id="file-text-preview"></div>
      </div>
    </div>

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

  </div><!-- /page-analyzer -->

  <!-- ============ ABOUT PAGE ============ -->
  <div class="page-view" id="page-about">

    <div class="about-section">
      <h2>How We Built the Gloo Analyzer</h2>
      <p>This tool was built in a single working session &mdash; a conversation between a human and an AI. No design sprints. No Jira tickets. No engineering team. Just a clear idea and a collaborative process that turned it into a working, deployed product in hours.</p>
      <p class="muted">Here's the full story of how it happened.</p>

      <h3>The Starting Point: A Framework on Paper</h3>
      <p>It began with a proprietary language framework &mdash; a structured approach to analyzing how companies talk about themselves. The framework was developed through analysis of 10+ companies across the AI-native and SaaS-native spectrum, scoring communications on seven dimensions and four diagnostic tells.</p>
      <p>The framework existed as a detailed written document: scoring rubrics for each dimension, translation guides, worked examples, and a clear output format. The question was: <em>Can we turn this into a tool anyone can use?</em></p>

      <h3>The Build: A Real-Time Conversation</h3>
      <p>The entire application was built through a human-AI conversation using <strong>Claude Code</strong> (Anthropic's agentic coding tool). Here's how the session unfolded:</p>

      <div class="timeline">
        <div class="timeline-item">
          <div class="step-label">Step 1 &mdash; Framework as System Prompt</div>
          <div class="step-text">The written framework was converted into a structured system prompt for the Anthropic API. Every API call sends this framework as context, so Claude analyzes text against the exact same rubric every time. <span class="muted">The framework lives in a file called framework-prompt.md &mdash; the brain of the whole tool.</span></div>
        </div>
        <div class="timeline-item">
          <div class="step-label">Step 2 &mdash; Core Engine</div>
          <div class="step-text">Claude Code wrote the Node.js application from scratch: an analyzer module that streams responses from the Anthropic API, a command-line interface for local testing, and an Express web server with a full UI. <span class="muted">First working version: ~200 lines of code across three files.</span></div>
        </div>
        <div class="timeline-item">
          <div class="step-label">Step 3 &mdash; First Test</div>
          <div class="step-text">We ran a sample Gloo press release through the CLI. The framework scored it 12 out of 35 (firmly SaaS-Native), flagged all four diagnostic tells as present, and provided line-by-line rewrites. <span class="muted">It worked on the first try.</span></div>
        </div>
        <div class="timeline-item">
          <div class="step-label">Step 4 &mdash; Deployment</div>
          <div class="step-text">The conversation included setting up the entire deployment pipeline: creating a GitHub repository from the terminal, authenticating with GitHub (a first-time experience), and deploying to Railway with environment variables. <span class="muted">From local code to live URL in minutes.</span></div>
        </div>
        <div class="timeline-item">
          <div class="step-label">Step 5 &mdash; File Upload</div>
          <div class="step-text">When the question came up &mdash; "Can I upload PowerPoint and Google Slides?" &mdash; the answer was built and deployed in the same session. Server-side parsing for PPTX, PDF, DOCX, and plain text files, with drag-and-drop in the UI. <span class="muted">New feature requested and shipped in one conversation turn.</span></div>
        </div>
        <div class="timeline-item">
          <div class="step-label">Step 6 &mdash; This Page</div>
          <div class="step-text">You're reading the result of yet another request in the same session. <span class="muted">The About page was added, committed, and deployed in the same ongoing conversation.</span></div>
        </div>
      </div>

      <div class="callout">
        <div class="callout-title">What makes this interesting</div>
        <p>This isn't a demo or a prototype. It's a working production tool, built entirely through human-AI collaboration. The human brought the domain expertise (the language framework, the strategic insight), and the AI handled the engineering (architecture, code, deployment, debugging).</p>
        <p>The entire process &mdash; from "I have a framework document" to "it's live on the internet and handles file uploads" &mdash; happened in a single conversation.</p>
      </div>

      <h3>The Tech Stack</h3>
      <div class="tech-grid">
        <div class="tech-card">
          <div class="tech-name">Claude Sonnet</div>
          <div class="tech-desc">Anthropic's API powers every analysis using the full framework as a system prompt</div>
        </div>
        <div class="tech-card">
          <div class="tech-name">Claude Code</div>
          <div class="tech-desc">Anthropic's agentic coding tool wrote the application code, debugged issues, and managed deployment</div>
        </div>
        <div class="tech-card">
          <div class="tech-name">Node.js + Express</div>
          <div class="tech-desc">Server-side runtime with streaming Server-Sent Events for real-time output</div>
        </div>
        <div class="tech-card">
          <div class="tech-name">Railway</div>
          <div class="tech-desc">Cloud hosting with auto-deploy from GitHub on every push</div>
        </div>
        <div class="tech-card">
          <div class="tech-name">JSZip + fast-xml-parser</div>
          <div class="tech-desc">Server-side extraction of text from PPTX and DOCX files (Office XML formats)</div>
        </div>
        <div class="tech-card">
          <div class="tech-name">unpdf</div>
          <div class="tech-desc">PDF text extraction with bundled PDF.js &mdash; zero external dependencies</div>
        </div>
      </div>

      <h3>The Framework Itself</h3>
      <p>The language framework at the heart of this tool scores communications across seven dimensions, each rated 1&ndash;5:</p>
      <ul>
        <li><strong>D1: Self-Description</strong> &mdash; How does the company describe itself? (Category label vs. category-transcendent)</li>
        <li><strong>D2: Unit of Value</strong> &mdash; What is the reader told they're getting? (Seats and licenses vs. lives impacted)</li>
        <li><strong>D3: Competitive Frame</strong> &mdash; Who or what is positioned as the competition? (Named vendors vs. civilizational challenges)</li>
        <li><strong>D4: CEO/Founder Voice</strong> &mdash; What register does leadership use? (Corporate boilerplate vs. worldview expression)</li>
        <li><strong>D5: Temporal Orientation</strong> &mdash; How does the text talk about time? (Fiscal quarters vs. generational shifts)</li>
        <li><strong>D6: Financial Narrative</strong> &mdash; How are results framed? (Revenue up X% vs. resource deployment against mission)</li>
        <li><strong>D7: Organizational Language</strong> &mdash; How is the team described? (Headcount and departments vs. callings and stewardship)</li>
      </ul>
      <p>It also checks for four diagnostic tells: SaaS boilerplate phrases, passive voice ratio, the "platform for" construction, and jargon density. The composite score (7&ndash;35) places any text on a spectrum from SaaS-Native to Mission-Native.</p>

      <h3>Open Source</h3>
      <p>The complete source code is available at <a href="https://github.com/jtwinsor494/gloo-analyzer" target="_blank">github.com/jtwinsor494/gloo-analyzer</a>.</p>
      <p class="muted" style="margin-top: 2rem; font-size: 0.8rem;">Built with Claude Code by Anthropic. The framework was developed by the Gloo team.</p>
    </div>

  </div><!-- /page-about -->

</div>

<script>
// --- Page switching (Analyzer / About) ---
function switchPage(page) {
  document.querySelectorAll(".page-nav-btn").forEach((b, i) => {
    b.classList.toggle("active", (i === 0 && page === "analyzer") || (i === 1 && page === "about"));
  });
  document.getElementById("page-analyzer").classList.toggle("active", page === "analyzer");
  document.getElementById("page-about").classList.toggle("active", page === "about");
}

// --- Tab switching ---
let activeTab = "paste";
let uploadedText = "";

function switchTab(tab) {
  activeTab = tab;
  document.querySelectorAll(".tab-btn").forEach((b, i) => {
    b.classList.toggle("active", (i === 0 && tab === "paste") || (i === 1 && tab === "upload"));
  });
  document.getElementById("tab-paste").classList.toggle("active", tab === "paste");
  document.getElementById("tab-upload").classList.toggle("active", tab === "upload");
}

// --- Paste text ---
document.getElementById("input").addEventListener("input", e => {
  document.getElementById("char-count").textContent = e.target.value.length;
});

// --- File upload ---
const fileInput = document.getElementById("file-input");
const uploadZone = document.getElementById("upload-zone");

// Drag & drop styling
uploadZone.addEventListener("dragover", e => { e.preventDefault(); uploadZone.classList.add("dragover"); });
uploadZone.addEventListener("dragleave", () => uploadZone.classList.remove("dragover"));
uploadZone.addEventListener("drop", e => {
  e.preventDefault();
  uploadZone.classList.remove("dragover");
  if (e.dataTransfer.files.length > 0) {
    fileInput.files = e.dataTransfer.files;
    handleFile(e.dataTransfer.files[0]);
  }
});
fileInput.addEventListener("change", () => {
  if (fileInput.files.length > 0) handleFile(fileInput.files[0]);
});

const formatIcons = { pptx: "&#128202;", pdf: "&#128196;", docx: "&#128195;", txt: "&#128221;", md: "&#128221;" };

async function handleFile(file) {
  const extracting = document.getElementById("extracting");
  const preview = document.getElementById("file-preview");
  extracting.style.display = "block";
  preview.classList.remove("visible");
  uploadedText = "";

  const formData = new FormData();
  formData.append("file", file);

  try {
    const res = await fetch("/api/extract", { method: "POST", body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Extraction failed");

    uploadedText = data.text;
    document.getElementById("file-icon").innerHTML = formatIcons[data.format] || "&#128196;";
    document.getElementById("file-name").textContent = data.filename;
    document.getElementById("file-meta").textContent = data.format.toUpperCase() + " \\u2022 " + data.chars.toLocaleString() + " characters extracted";
    document.getElementById("file-text-preview").textContent = data.text.slice(0, 500) + (data.text.length > 500 ? "\\n\\n... (truncated preview)" : "");
    preview.classList.add("visible");
  } catch (err) {
    alert("Error: " + err.message);
  } finally {
    extracting.style.display = "none";
  }
}

function removeFile() {
  uploadedText = "";
  fileInput.value = "";
  document.getElementById("file-preview").classList.remove("visible");
}

// --- Copy ---
function copyOutput() {
  navigator.clipboard.writeText(rawOutput).then(() => {
    const btn = document.getElementById("copy-btn");
    btn.textContent = "Copied!";
    setTimeout(() => btn.textContent = "Copy", 1500);
  });
}

// --- Minimal markdown renderer ---
function renderMd(src) {
  let html = src
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/^### (.+)$/gm, "<h3>$1</h3>")
    .replace(/^## (.+)$/gm, "<h2>$1</h2>")
    .replace(/^# (.+)$/gm, "<h1>$1</h1>")
    .replace(/^---$/gm, "<hr>")
    .replace(/\\*\\*\\*(.+?)\\*\\*\\*/g, "<strong><em>$1</em></strong>")
    .replace(/\\*\\*(.+?)\\*\\*/g, "<strong>$1</strong>")
    .replace(/\\*(.+?)\\*/g, "<em>$1</em>")
    .replace(/\\\`([^\\\`]+)\\\`/g, "<code>$1</code>")
    .replace(/^&gt; (.+)$/gm, "<blockquote>$1</blockquote>")
    .replace(/^- (.+)$/gm, "<li>$1</li>")
    .replace(/\\n\\n/g, "</p><p>")
    .replace(/\\n/g, "<br>");
  html = html.replace(/(<li>.*?<\\/li>(?:<br>)?)+/g, (m) => "<ul>" + m.replace(/<br>/g, "") + "</ul>");
  return "<p>" + html + "</p>";
}

let rawOutput = "";

// --- Run analysis ---
async function runAnalysis() {
  // Get text from active tab
  let text;
  if (activeTab === "upload") {
    text = uploadedText;
    if (!text) { alert("Please upload a file first."); return; }
  } else {
    text = document.getElementById("input").value.trim();
    if (!text) { alert("Please enter some text to analyze."); return; }
  }

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
            output.textContent = rawOutput;
            const cursorEl = document.createElement("span");
            cursorEl.className = "cursor";
            output.appendChild(cursorEl);
            output.scrollTop = output.scrollHeight;
          }
        } catch {}
      }
    }

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
