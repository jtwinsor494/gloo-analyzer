/**
 * File parser module — extracts plain text from uploaded files.
 * Supported formats: .pptx, .pdf, .txt, .md, .docx (basic)
 */

import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";

// ── PPTX ────────────────────────────────────────────────────────────────────

/**
 * Extract all text from a .pptx buffer.
 * PPTX is a ZIP containing XML slides. Text lives in <a:t> tags.
 */
export async function extractPptxText(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const parser = new XMLParser({ ignoreAttributes: false });

  // Collect slide filenames and sort numerically
  const slideNames = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => {
      const numA = parseInt(a.match(/slide(\d+)/)[1], 10);
      const numB = parseInt(b.match(/slide(\d+)/)[1], 10);
      return numA - numB;
    });

  if (slideNames.length === 0) {
    throw new Error("No slides found in PPTX file");
  }

  const allText = [];

  for (const name of slideNames) {
    const xml = await zip.files[name].async("text");
    const parsed = parser.parse(xml);
    const slideTexts = [];
    extractTextNodes(parsed, slideTexts);
    if (slideTexts.length > 0) {
      const slideNum = name.match(/slide(\d+)/)[1];
      allText.push(`[Slide ${slideNum}]`);
      allText.push(slideTexts.join(" "));
      allText.push(""); // blank line between slides
    }
  }

  const text = allText.join("\n").trim();
  if (!text) throw new Error("No text content found in PPTX slides");
  return text;
}

function extractTextNodes(obj, results) {
  if (obj == null || typeof obj !== "object") return;
  for (const [key, value] of Object.entries(obj)) {
    if (key === "a:t") {
      if (typeof value === "string") results.push(value);
      else if (Array.isArray(value)) results.push(...value.map(String));
      else results.push(String(value));
    } else if (Array.isArray(value)) {
      value.forEach((v) => extractTextNodes(v, results));
    } else if (typeof value === "object") {
      extractTextNodes(value, results);
    }
  }
}

// ── PDF ──────────────────────────────────────────────────────────────────────

/**
 * Extract all text from a .pdf buffer.
 * Uses unpdf which bundles PDF.js internally.
 */
export async function extractPdfText(buffer) {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { text } = await extractText(pdf, { mergePages: true });
  if (!text || !text.trim()) throw new Error("No text content found in PDF");
  return text.trim();
}

// ── DOCX (basic) ────────────────────────────────────────────────────────────

/**
 * Extract text from a .docx buffer.
 * DOCX is a ZIP containing XML. Body text lives in <w:t> tags.
 */
export async function extractDocxText(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const docFile = zip.files["word/document.xml"];
  if (!docFile) throw new Error("No document.xml found in DOCX file");

  const parser = new XMLParser({ ignoreAttributes: false });
  const xml = await docFile.async("text");
  const parsed = parser.parse(xml);

  const texts = [];
  extractDocxNodes(parsed, texts);
  const text = texts.join(" ").trim();
  if (!text) throw new Error("No text content found in DOCX");
  return text;
}

function extractDocxNodes(obj, results) {
  if (obj == null || typeof obj !== "object") return;
  for (const [key, value] of Object.entries(obj)) {
    if (key === "w:t") {
      if (typeof value === "string") results.push(value);
      else if (typeof value === "object" && value["#text"])
        results.push(String(value["#text"]));
      else if (Array.isArray(value))
        results.push(
          ...value.map((v) =>
            typeof v === "string" ? v : v["#text"] ? String(v["#text"]) : ""
          )
        );
      else results.push(String(value));
    } else if (Array.isArray(value)) {
      value.forEach((v) => extractDocxNodes(v, results));
    } else if (typeof value === "object") {
      extractDocxNodes(value, results);
    }
  }
}

// ── Plain text ──────────────────────────────────────────────────────────────

export function extractPlainText(buffer) {
  return buffer.toString("utf-8").trim();
}

// ── Main dispatcher ─────────────────────────────────────────────────────────

const SUPPORTED_TYPES = {
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    "pptx",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "docx",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/markdown": "md",
};

/**
 * Extract text from a file buffer based on its MIME type or filename extension.
 * Returns { text, format } where format is e.g. "pptx", "pdf", etc.
 */
export async function extractText(buffer, { mimetype, originalname } = {}) {
  // Determine format from MIME or extension
  let format = SUPPORTED_TYPES[mimetype];
  if (!format && originalname) {
    const ext = originalname.split(".").pop().toLowerCase();
    const extMap = { pptx: "pptx", pdf: "pdf", docx: "docx", txt: "txt", md: "md" };
    format = extMap[ext];
  }

  if (!format) {
    const supported = "PPTX, PDF, DOCX, TXT, MD";
    throw new Error(
      `Unsupported file type. Supported formats: ${supported}`
    );
  }

  let text;
  switch (format) {
    case "pptx":
      text = await extractPptxText(buffer);
      break;
    case "pdf":
      text = await extractPdfText(buffer);
      break;
    case "docx":
      text = await extractDocxText(buffer);
      break;
    case "txt":
    case "md":
      text = extractPlainText(buffer);
      break;
  }

  return { text, format };
}
