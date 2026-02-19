#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ─── Constants ───────────────────────────────────────────────────────────────

const BASE_URL = "https://api.fda.gov/device";

const PANEL_CODES: Record<string, string> = {
  AN: "Anesthesiology",
  CV: "Cardiovascular",
  CH: "Clinical Chemistry",
  DE: "Dental",
  EN: "Ear, Nose, Throat",
  GU: "Gastroenterology, Urology",
  HO: "General Hospital",
  HE: "Hematology",
  IM: "Immunology",
  MI: "Microbiology",
  NE: "Neurology",
  OB: "Obstetrics/Gynecology",
  OP: "Ophthalmic",
  OR: "Orthopedic",
  PA: "Pathology",
  PM: "Physical Medicine",
  RA: "Radiology",
  SU: "General, Plastic Surgery",
  TX: "Clinical Toxicology",
};

const PANEL_LIST = Object.entries(PANEL_CODES)
  .map(([code, name]) => `${code}=${name}`)
  .join(", ");

// ─── Validation ──────────────────────────────────────────────────────────────

const K_NUMBER_RE = /^K\d{6,7}$/i;
const PMA_NUMBER_RE = /^P\d{6}$/i;
const PRODUCT_CODE_RE = /^[A-Z]{3}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validateProductCode(value: string): string | null {
  if (K_NUMBER_RE.test(value)) {
    return `"${value}" looks like a 510(k) number, not a product code. Use classify_device to find the product code, or search_510k with the k_number parameter.`;
  }
  if (PMA_NUMBER_RE.test(value)) {
    return `"${value}" looks like a PMA number, not a product code. Use classify_device to find the product code, or search_pma with the pma_number parameter.`;
  }
  if (!PRODUCT_CODE_RE.test(value)) {
    return `"${value}" is not a valid 3-letter product code. Product codes are exactly 3 letters (e.g., "DXN"). Use classify_device with a query to find the right code.`;
  }
  return null;
}

function validateDate(value: string): string | null {
  if (!DATE_RE.test(value)) {
    return `"${value}" is not a valid date. Use YYYY-MM-DD format (e.g., "2024-01-15").`;
  }
  return null;
}

function stripDashes(date: string): string {
  return date.replace(/-/g, "");
}

function normalizeDateResponse(date: string | undefined): string | null {
  if (!date) return null;
  if (/^\d{8}$/.test(date)) {
    return `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
  }
  if (DATE_RE.test(date)) return date;
  return date;
}

function daysBetween(dateA: string, dateB: string): number | null {
  const a = new Date(dateA);
  const b = new Date(dateB);
  if (isNaN(a.getTime()) || isNaN(b.getTime())) return null;
  return Math.round((b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24));
}

// ─── Source Link Builders ────────────────────────────────────────────────────

function link510k(kNumber: string): string {
  return `https://www.accessdata.fda.gov/scripts/cdrh/cfdocs/cfpmn/pmn.cfm?ID=${kNumber}`;
}

function linkPMA(pmaNumber: string): string {
  return `https://www.accessdata.fda.gov/scripts/cdrh/cfdocs/cfpma/pma.cfm?id=${pmaNumber}`;
}

function linkClassification(productCode: string): string {
  return `https://www.accessdata.fda.gov/scripts/cdrh/cfdocs/cfpcd/classification.cfm?ID=${productCode}`;
}

function linkRecall(cfresId: string): string {
  return `https://www.accessdata.fda.gov/scripts/cdrh/cfdocs/cfres/res.cfm?id=${cfresId}`;
}

function linkMAUDE(mdrReportKey: string): string {
  return `https://www.accessdata.fda.gov/scripts/cdrh/cfdocs/cfmaude/detail.cfm?mdrfoi__id=${mdrReportKey}`;
}

function linkECFR(regulationNumber: string): string {
  const parts = regulationNumber.split(".");
  if (parts.length !== 2) return "";
  return `https://www.ecfr.gov/current/title-21/chapter-I/subchapter-H/part-${parts[0]}/section-${regulationNumber}`;
}

// ─── API Client ──────────────────────────────────────────────────────────────

interface OpenFDAResponse {
  meta?: {
    results?: { total?: number; skip?: number; limit?: number };
    last_updated?: string;
  };
  results?: Record<string, unknown>[];
  error?: { code?: string; message?: string };
}

async function queryOpenFDA(
  endpoint: string,
  searchParts: string[],
  options: { limit?: number; sort?: string } = {}
): Promise<{ data: OpenFDAResponse; url: string }> {
  // Build URL manually — URLSearchParams encodes + as %2B which breaks openFDA's +AND+ syntax
  const queryParts: string[] = [];
  if (searchParts.length > 0) {
    queryParts.push(`search=${searchParts.join("+AND+")}`);
  }
  queryParts.push(`limit=${options.limit ?? 10}`);
  if (options.sort) queryParts.push(`sort=${options.sort}`);

  const url = `${BASE_URL}/${endpoint}.json?${queryParts.join("&")}`;

  let response: Response;
  try {
    response = await fetch(url);
  } catch (err) {
    return {
      data: { error: { code: "NETWORK", message: "Unable to reach openFDA API. Check connectivity." } },
      url,
    };
  }

  if (response.status === 429) {
    return {
      data: { error: { code: "429", message: "openFDA rate limit reached (240 req/min). Try again shortly." } },
      url,
    };
  }

  if (!response.ok) {
    const text = await response.text();
    let parsed: OpenFDAResponse;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { error: { code: String(response.status), message: text.slice(0, 500) } };
    }
    return { data: parsed, url };
  }

  const data = (await response.json()) as OpenFDAResponse;
  return { data, url };
}

function buildSearchTerms(field: string, query: string): string {
  const terms = query.trim().split(/\s+/);
  if (terms.length === 1) return `${field}:${terms[0]}`;
  return terms.map((t) => `${field}:${t}`).join("+AND+");
}

// ─── Synonym Map ──────────────────────────────────────────────────────────────
// Maps common user terms → FDA formal terminology. Keys must be lowercase.
const SYNONYMS: Record<string, string[]> = {
  ecg: ["electrocardiograph"],
  ekg: ["electrocardiograph"],
  robot: ["computer controlled instrument"],
  robotic: ["computer controlled instrument"],
  bp: ["blood pressure"],
  cgm: ["continuous glucose monitor"],
  ai: ["artificial intelligence"],
  mri: ["magnetic resonance imaging"],
  ct: ["computed tomography"],
  xray: ["x-ray"],
  "x-ray": ["radiographic"],
  ultrasound: ["ultrasonic"],
  cpap: ["continuous positive airway pressure"],
  tens: ["transcutaneous electrical nerve stimulation"],
  iud: ["intrauterine"],
  stent: ["endoprosthesis"],
  pacemaker: ["pulse generator"],
  defibrillator: ["defibrillator"],
  ventilator: ["ventilator"],
  catheter: ["catheter"],
  laser: ["laser"],
  pump: ["infusion pump"],
  thermometer: ["thermometer"],
  oximeter: ["oximeter"],
  hearing: ["hearing aid"],
  insulin: ["insulin"],
  dialysis: ["hemodialysis"],
  prosthetic: ["prosthesis"],
  implant: ["implant"],
  endoscope: ["endoscope"],
  monitor: ["monitor"],
  wearable: ["wearable"],
  patch: ["ambulatory"],
  portable: ["portable"],
  wireless: ["wireless"],
  bluetooth: ["wireless"],
  home: ["home use"],
  otc: ["over-the-counter"],
  samd: ["software"],
  "software device": ["software"],
  app: ["software", "mobile"],
  cad: ["computer aided detection"],
  "cad-x": ["computer aided diagnosis"],
  triage: ["triage"],
  diagnostic: ["diagnostic"],
  screening: ["screening"],
  imaging: ["image processing"],
  ehr: ["electronic health record"],
  clinical: ["clinical decision support"],
  cds: ["clinical decision support"],
  ml: ["machine learning"],
  "deep learning": ["machine learning"],
  algorithm: ["algorithm"],
  waveform: ["electrocardiograph"],
  "heart monitor": ["electrocardiograph"],
  "heart rate": ["heart rate"],
  "blood sugar": ["glucose"],
  glucometer: ["glucose meter"],
  spo2: ["oximeter"],
  "sleep apnea": ["sleep apnea"],
  mammography: ["mammograph"],
  mammogram: ["mammograph"],
  polyp: ["lesion"],
  colonoscopy: ["endoscope gastrointestinal"],
  endoscopy: ["endoscope"],
  dental: ["dental"],
  dermatology: ["dermatoscope"],
  retinal: ["retinal"],
  fundus: ["fundus"],
  stroke: ["stroke"],
  aneurysm: ["aneurysm"],
  fracture: ["fracture"],
  tumor: ["lesion"],
  cancer: ["cancer"],
  detection: ["detection"],
  diagnosis: ["diagnosis"],
};

// Expand user query terms using synonym map. Returns deduplicated expanded terms array.
function expandSynonyms(terms: string[]): string[] {
  const expanded: string[] = [];
  const seen = new Set<string>();
  for (const term of terms) {
    const key = term.toLowerCase();
    if (SYNONYMS[key]) {
      for (const syn of SYNONYMS[key]) {
        for (const word of syn.split(/\s+/)) {
          const lower = word.toLowerCase();
          if (!seen.has(lower)) {
            seen.add(lower);
            expanded.push(word);
          }
        }
      }
    } else {
      if (!seen.has(key)) {
        seen.add(key);
        expanded.push(term);
      }
    }
  }
  return expanded;
}

// Generate term combinations ordered by length (longest first), then left-to-right.
// For [A, B, C] → [[A,B,C], [A,B], [B,C], [A,C], [A], [B], [C]]
function generateCombinations(terms: string[]): string[][] {
  if (terms.length <= 1) return [terms];

  const combos: string[][] = [];
  // Group by size, largest first
  for (let size = terms.length; size >= 1; size--) {
    // Generate all contiguous and non-contiguous combos of this size
    const indices = getCombinationIndices(terms.length, size);
    for (const idx of indices) {
      combos.push(idx.map((i) => terms[i]));
    }
  }
  return combos;
}

// Get all index combinations of `size` from `n` items, preferring contiguous runs
function getCombinationIndices(n: number, size: number): number[][] {
  const contiguous: number[][] = [];
  const nonContiguous: number[][] = [];

  function* combine(start: number, picked: number[]): Generator<number[]> {
    if (picked.length === size) { yield [...picked]; return; }
    for (let i = start; i < n; i++) {
      picked.push(i);
      yield* combine(i + 1, picked);
      picked.pop();
    }
  }

  for (const combo of combine(0, [])) {
    // Check if contiguous
    let isContiguous = true;
    for (let i = 1; i < combo.length; i++) {
      if (combo[i] !== combo[i - 1] + 1) { isContiguous = false; break; }
    }
    if (isContiguous) contiguous.push(combo);
    else nonContiguous.push(combo);
  }

  return [...contiguous, ...nonContiguous];
}

// Score how relevant results are to the original query terms.
// Returns 0-1 where 1 = all original terms "covered" in device names/definitions.
// A term is "covered" if either the term itself or any of its synonym expansions appear.
function scoreResults(results: Record<string, unknown>[], originalTerms: string[]): number {
  if (!results.length || !originalTerms.length) return 0;

  // Build a coverage map: for each original term, what strings count as a match?
  const coverageMap: { original: string; matchStrings: string[] }[] = originalTerms.map((t) => {
    const lower = t.toLowerCase();
    const expansions = SYNONYMS[lower]
      ? SYNONYMS[lower].flatMap((s) => s.toLowerCase().split(/\s+/))
      : [];
    return { original: lower, matchStrings: [lower, ...expansions] };
  });

  let totalScore = 0;
  for (const r of results) {
    const name = ((r.device_name as string) ?? "").toLowerCase();
    const def = ((r.definition as string) ?? "").toLowerCase();
    const text = `${name} ${def}`;
    let covered = 0;
    for (const { matchStrings } of coverageMap) {
      if (matchStrings.some((s) => text.includes(s))) covered++;
    }
    totalScore += covered / coverageMap.length;
  }
  return totalScore / results.length;
}

function formatFooter(url: string, meta?: OpenFDAResponse["meta"]): string {
  const lastUpdated = meta?.last_updated ?? "unknown";
  return [
    "---",
    `Query: ${decodeURIComponent(url)}`,
    `Data source: openFDA (last updated: ${lastUpdated})`,
    `Disclaimer: openFDA data is unvalidated. Verify on FDA.gov before making regulatory decisions.`,
  ].join("\n");
}

function formatError(data: OpenFDAResponse, url: string): string {
  const msg = data.error?.message ?? "Unknown error";
  return `Error: ${msg}\n\n${formatFooter(url, data.meta)}`;
}

// ─── MCP Server ──────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "fda-devices",
  version: "1.0.0",
});

// ─── Tool 1: classify_device ─────────────────────────────────────────────────

server.tool(
  "classify_device",
  `Look up FDA device classification by product code or device name. Returns product code, device class (I/II/III), regulation number, and regulatory details. FDA uses formal names like "Electrocardiograph, Ambulatory" not "wearable ECG patch" — try generic medical terms. If no results, try shorter/broader terms. Use this tool first to find the product code, then use other tools with that code. Panel codes: ${PANEL_LIST}.`,
  {
    product_code: z.string().optional().describe("Exact 3-letter FDA product code (e.g., 'DXN')"),
    query: z.string().optional().describe("Device name or description to search for"),
    device_class: z.enum(["1", "2", "3"]).optional().describe("Filter by device class"),
    limit: z.number().min(1).max(50).optional().describe("Results to return (default 10)"),
  },
  async ({ product_code, query, device_class, limit }) => {
    if (!product_code && !query) {
      return { content: [{ type: "text" as const, text: "Error: Provide either product_code or query." }] };
    }

    const resultLimit = limit ?? 10;

    // Auto-detect product code passed as query (e.g., query="QIH" instead of product_code="QIH")
    if (!product_code && query && PRODUCT_CODE_RE.test(query.trim())) {
      product_code = query.trim().toUpperCase();
      query = undefined;
    }

    // Direct product code lookup
    if (product_code) {
      const err = validateProductCode(product_code);
      if (err) return { content: [{ type: "text" as const, text: `Validation error: ${err}` }] };

      const searchParts = [`product_code:${product_code.toUpperCase()}`];
      if (device_class) searchParts.push(`device_class:${device_class}`);

      const { data, url } = await queryOpenFDA("classification", searchParts, { limit: resultLimit });
      if (data.error) return { content: [{ type: "text" as const, text: formatError(data, url) }] };
      if (!data.results?.length) {
        return {
          content: [{
            type: "text" as const,
            text: `No classification found for product code ${product_code.toUpperCase()}. Verify at: ${linkClassification(product_code.toUpperCase())}\n\n${formatFooter(url, data.meta)}`,
          }],
        };
      }

      return { content: [{ type: "text" as const, text: formatClassificationResults(data, url) }] };
    }

    // Multi-pass query search with synonym expansion and combinatorial broadening
    const originalTerms = query!.trim().split(/\s+/);
    const expandedTerms = expandSynonyms(originalTerms);
    const hasExpansion = expandedTerms.join(" ") !== originalTerms.join(" ");

    // Build candidate term lists: expanded first (if different), then original
    const termSets: { terms: string[]; label: string }[] = [];
    if (hasExpansion) termSets.push({ terms: expandedTerms, label: "expanded" });
    termSets.push({ terms: originalTerms, label: "original" });

    // Track best weak result in case no strong match is found
    let bestWeak: { data: OpenFDAResponse; url: string; score: number } | null = null;
    const RELEVANCE_THRESHOLD = 0.4; // at least 40% of original terms should be covered (directly or via synonyms)

    // Filler words that add noise to FDA classification searches
    const FILLER_WORDS = new Set([
      "a", "an", "the", "for", "of", "in", "on", "to", "and", "or", "is", "it",
      "what", "how", "which", "my", "with", "from", "that", "this",
      "fda", "class", "device", "medical", "need", "does",
    ]);

    const MAX_API_CALLS = 30; // Cap total API calls to avoid rate limits
    let apiCalls = 0;

    for (const { terms } of termSets) {
      // Filter out filler words for combo generation
      const meaningful = terms.filter((t) => !FILLER_WORDS.has(t.toLowerCase()) && t.length > 1);
      const termsToUse = meaningful.length >= 2 ? meaningful : terms;

      // Prioritize: full length first, then 2-3 term combos (sweet spot for FDA names),
      // then longer combos. This ensures we reach specific medical pairs quickly.
      const allCombos = generateCombinations(termsToUse);
      const fullLength = allCombos.filter((c) => c.length === termsToUse.length);
      const shortCombos = allCombos.filter((c) => c.length >= 2 && c.length <= 3 && c.length < termsToUse.length);
      const mediumCombos = allCombos.filter((c) => c.length > 3 && c.length < termsToUse.length);
      const singles = allCombos.filter((c) => c.length === 1);
      const combos = [...fullLength, ...shortCombos, ...mediumCombos, ...singles];

      for (const combo of combos) {
        if (apiCalls >= MAX_API_CALLS) break;

        // For each combination, try both device_name and definition
        const fields = ["device_name", "definition"] as const;

        for (const field of fields) {
          if (apiCalls >= MAX_API_CALLS) break;
          apiCalls++;

          const searchParts = [buildSearchTerms(field, combo.join(" "))];
          if (device_class) searchParts.push(`device_class:${device_class}`);

          const { data, url } = await queryOpenFDA("classification", searchParts, { limit: resultLimit });

          if (!data.error && data.results && data.results.length > 0) {
            const score = scoreResults(data.results, originalTerms);

            // Full-length combo or strong relevance: return immediately
            if (combo.length >= termsToUse.length || score >= RELEVANCE_THRESHOLD) {
              return { content: [{ type: "text" as const, text: formatClassificationResults(data, url) }] };
            }

            // Weak match: save if it's the best so far
            if (!bestWeak || score > bestWeak.score) {
              bestWeak = { data, url, score };
            }
          }
        }
      }
    }

    // Return best weak match if we found anything
    if (bestWeak) {
      return { content: [{ type: "text" as const, text: formatClassificationResults(bestWeak.data, bestWeak.url) }] };
    }

    // Pass 3: 510(k) bridge — search 510(k) device names, extract product codes, look up classifications
    // Many AI/SaMD devices are classified under generic codes (e.g., MYN "Analyzer, Medical Image")
    // but have specific names in 510(k) submissions. This bridges the gap.
    const bridgeResult = await bridgeVia510k(query!, originalTerms, expandedTerms, device_class, resultLimit);
    if (bridgeResult) {
      return { content: [{ type: "text" as const, text: bridgeResult }] };
    }

    // Nothing found anywhere — give actionable suggestions
    const suggestions: string[] = [];
    const lowerQuery = query!.toLowerCase();

    // Detect if query is about AI/SaMD (common miss category)
    const aiTerms = ["ai", "ml", "algorithm", "machine learning", "deep learning", "artificial intelligence", "samd", "software"];
    const isAIQuery = originalTerms.some((t) => aiTerms.includes(t.toLowerCase()));

    if (isAIQuery) {
      suggestions.push(
        `Many AI/ML-enabled devices are classified under generic product codes:`,
        `  - **QIH** — Automated Radiological Image Processing Software`,
        `  - **QDQ** — Radiological Computer Assisted Detection/Diagnosis Software`,
        `  - **MYN** — Analyzer, Medical Image`,
        `  - **QBS** — Radiological CAD Software For Fracture`,
        `  - **QNP** — Gastrointestinal Lesion Software Detection System`,
        `  - **QJU** — Image Acquisition/Optimization Guided By AI`,
        ``,
        `Try: \`classify_device\` with one of these product codes, or \`search_510k\` with applicant/device_name to find specific cleared products.`,
      );
    } else {
      suggestions.push(
        `Suggestions:`,
        `  - Try shorter or broader medical terms (FDA uses formal names like "Oximeter, Pulse" not "pulse oximeter")`,
        `  - Use \`search_510k\` with \`device_name\` or \`applicant\` to find specific cleared devices`,
        `  - If you know the company, search by applicant name in \`search_510k\``,
      );
    }

    const fallbackUrl = `${BASE_URL}/classification.json?search=${buildSearchTerms("device_name", query!)}&limit=1`;
    return {
      content: [{
        type: "text" as const,
        text: `No classification results found for "${query}".\n\n${suggestions.join("\n")}\n\n${formatFooter(fallbackUrl)}`,
      }],
    };
  }
);

// 510(k) bridge: when classification search fails, search 510(k) device names
// to discover product codes, then look up those codes in classification.
async function bridgeVia510k(
  query: string,
  originalTerms: string[],
  expandedTerms: string[],
  device_class: string | undefined,
  resultLimit: number,
): Promise<string | null> {
  // Try both expanded and original terms against 510(k) device_name
  const termSets = [expandedTerms, originalTerms];
  const seen510k = new Set<string>();

  // Generic terms that are too broad to search alone in 510(k) device names
  const GENERIC_510K_TERMS = new Set([
    "artificial", "intelligence", "machine", "learning", "software", "device",
    "system", "detection", "screening", "diagnosis", "diagnostic", "analysis",
    "monitor", "automated", "computer", "digital", "algorithm", "image",
    "processing", "aided", "based", "clinical", "decision", "support",
  ]);

  for (const terms of termSets) {
    // Separate medical-specific terms from generic ones for smarter combo generation
    const medicalTerms = terms.filter((t) => !GENERIC_510K_TERMS.has(t.toLowerCase()));
    const combos = generateCombinations(terms);
    // Try combos from longest down to pairs; only allow single-term searches for
    // specific enough medical terms (>= 5 chars to avoid "low", "GI", etc.)
    const pairAndUp = combos.filter((c) => c.length >= 2).slice(0, 8);
    const medicalSingles = medicalTerms.filter((t) => t.length >= 5).map((t) => [t]);
    const topCombos = [...pairAndUp, ...medicalSingles];

    for (const combo of topCombos) {
      const searchExpr = buildSearchTerms("device_name", combo.join(" "));
      const key = combo.join("+");
      if (seen510k.has(key)) continue;
      seen510k.add(key);

      const { data } = await queryOpenFDA("510k", [searchExpr], { limit: 20, sort: "decision_date:desc" });

      if (!data.error && data.results && data.results.length > 0) {
        // Extract unique product codes from 510(k) results
        const productCodes = new Map<string, { code: string; deviceNames: string[]; count: number }>();
        for (const r of data.results) {
          const pc = (r.product_code as string)?.toUpperCase();
          if (!pc || !PRODUCT_CODE_RE.test(pc)) continue;
          const existing = productCodes.get(pc);
          if (existing) {
            existing.count++;
            const name = r.device_name as string;
            if (name && !existing.deviceNames.includes(name)) existing.deviceNames.push(name);
          } else {
            productCodes.set(pc, { code: pc, deviceNames: [r.device_name as string].filter(Boolean), count: 1 });
          }
        }

        if (productCodes.size === 0) continue;

        // Look up each unique product code in classification
        const classificationResults: Record<string, unknown>[] = [];
        const classUrls: string[] = [];
        for (const [pc] of productCodes) {
          const searchParts = [`product_code:${pc}`];
          if (device_class) searchParts.push(`device_class:${device_class}`);
          const { data: classData, url: classUrl } = await queryOpenFDA("classification", searchParts, { limit: 1 });
          if (!classData.error && classData.results?.length) {
            classificationResults.push(...classData.results);
            classUrls.push(classUrl);
          }
        }

        if (classificationResults.length === 0) continue;

        // Build response showing classification + the 510(k) devices that led to it
        const lines: string[] = [
          `No direct classification match for "${query}". Found ${classificationResults.length} classification(s) via 510(k) device name search:\n`,
        ];

        for (const r of classificationResults) {
          const pc = r.product_code as string;
          const regNum = r.regulation_number as string;
          const pcInfo = productCodes.get(pc);
          lines.push(`**${pc}** — ${r.device_name}`);
          lines.push(`  Class: ${r.device_class} | Regulation: ${regNum}`);
          lines.push(`  Panel: ${r.medical_specialty} (${r.medical_specialty_description})`);
          if (r.definition) lines.push(`  Definition: ${(r.definition as string).slice(0, 200)}${(r.definition as string).length > 200 ? "..." : ""}`);
          lines.push(`  Implant: ${r.implant_flag} | Life-sustaining: ${r.life_sustain_support_flag} | GMP exempt: ${r.gmp_exempt_flag}`);
          lines.push(`  Third-party eligible: ${r.third_party_flag} | Submission type: ${r.submission_type_id}`);
          lines.push(`  FDA source: ${linkClassification(pc)}`);
          if (regNum) lines.push(`  eCFR: ${linkECFR(regNum)}`);
          if (pcInfo) {
            lines.push(`  _Found via 510(k) devices: ${pcInfo.deviceNames.slice(0, 3).join("; ")}${pcInfo.deviceNames.length > 3 ? ` (+${pcInfo.deviceNames.length - 3} more)` : ""}_`);
          }
          lines.push("");
        }

        // Show a few example 510(k)s that matched
        const exampleDevices = data.results.slice(0, 5);
        lines.push(`**510(k) matches for "${query}"** (${data.meta?.results?.total ?? data.results.length} total):\n`);
        for (const r of exampleDevices) {
          const kn = r.k_number as string;
          const decisionDate = normalizeDateResponse(r.decision_date as string);
          lines.push(`- **${kn}** ${r.device_name} — ${r.applicant} (${decisionDate ?? "N/A"}) [${r.product_code}]`);
        }
        lines.push("");

        const bridgeUrl = `${BASE_URL}/510k.json?search=${searchExpr}&limit=20&sort=decision_date:desc`;
        lines.push(formatFooter(bridgeUrl, data.meta));
        return lines.join("\n");
      }
    }
  }

  return null;
}

function formatClassificationResults(data: OpenFDAResponse, url: string): string {
  const total = data.meta?.results?.total ?? 0;
  const results = data.results ?? [];
  const lines: string[] = [`Found ${total} classification result(s).\n`];

  for (const r of results) {
    const pc = r.product_code as string;
    const regNum = r.regulation_number as string;
    lines.push(`**${pc}** — ${r.device_name}`);
    lines.push(`  Class: ${r.device_class} | Regulation: ${regNum}`);
    lines.push(`  Panel: ${r.medical_specialty} (${r.medical_specialty_description})`);
    if (r.definition) lines.push(`  Definition: ${(r.definition as string).slice(0, 200)}${(r.definition as string).length > 200 ? "..." : ""}`);
    lines.push(`  Implant: ${r.implant_flag} | Life-sustaining: ${r.life_sustain_support_flag} | GMP exempt: ${r.gmp_exempt_flag}`);
    lines.push(`  Third-party eligible: ${r.third_party_flag} | Submission type: ${r.submission_type_id}`);
    lines.push(`  FDA source: ${linkClassification(pc)}`);
    if (regNum) lines.push(`  eCFR: ${linkECFR(regNum)}`);
    lines.push("");
  }

  lines.push(formatFooter(url, data.meta));
  return lines.join("\n");
}

// ─── Tool 2: search_510k ────────────────────────────────────────────────────

server.tool(
  "search_510k",
  `Search FDA 510(k) clearance database. Best used with a product_code from classify_device, or a specific k_number for direct lookup. Company names vary in FDA data ("Medtronic" vs "Medtronic, Inc." vs "MEDTRONIC INC") — try partial names. Returns clearance details with FDA source links. Panel codes: ${PANEL_LIST}.`,
  {
    product_code: z.string().optional().describe("3-letter FDA product code"),
    k_number: z.string().optional().describe("Specific 510(k) number (e.g., 'K032161')"),
    applicant: z.string().optional().describe("Company name (partial match)"),
    device_name: z.string().optional().describe("Device name search"),
    decision: z.enum(["SESE", "SEKN", "SESD"]).optional().describe("Decision code: SESE=substantially equivalent, SEKN=not SE, SESD=SE with limitations"),
    clearance_type: z.enum(["Traditional", "Special", "Abbreviated"]).optional().describe("Clearance type"),
    advisory_committee: z.string().optional().describe("Panel code (e.g., 'CV', 'SU', 'OR')"),
    date_from: z.string().optional().describe("Decision date start (YYYY-MM-DD)"),
    date_to: z.string().optional().describe("Decision date end (YYYY-MM-DD)"),
    limit: z.number().min(1).max(50).optional().describe("Results to return (default 10)"),
  },
  async ({ product_code, k_number, applicant, device_name, decision, clearance_type, advisory_committee, date_from, date_to, limit }) => {
    if (!product_code && !k_number && !applicant && !device_name) {
      return { content: [{ type: "text" as const, text: "Error: Provide at least one of product_code, k_number, applicant, or device_name." }] };
    }

    if (product_code) {
      const err = validateProductCode(product_code);
      if (err) return { content: [{ type: "text" as const, text: `Validation error: ${err}` }] };
    }
    if (k_number && !K_NUMBER_RE.test(k_number)) {
      return { content: [{ type: "text" as const, text: `Validation error: "${k_number}" is not a valid 510(k) number. Format: K followed by 6-7 digits (e.g., K032161).` }] };
    }
    if (date_from) { const err = validateDate(date_from); if (err) return { content: [{ type: "text" as const, text: `Validation error (date_from): ${err}` }] }; }
    if (date_to) { const err = validateDate(date_to); if (err) return { content: [{ type: "text" as const, text: `Validation error (date_to): ${err}` }] }; }

    const searchParts: string[] = [];

    if (k_number) {
      searchParts.push(`k_number:${k_number.toUpperCase()}`);
    } else {
      if (product_code) searchParts.push(`product_code:${product_code.toUpperCase()}`);
      if (applicant) searchParts.push(`applicant:"${applicant}"`);
      if (device_name) searchParts.push(`device_name:"${device_name}"`);
      if (decision) searchParts.push(`decision_code:${decision}`);
      if (clearance_type) searchParts.push(`clearance_type:"${clearance_type}"`);
      if (advisory_committee) searchParts.push(`advisory_committee:${advisory_committee.toUpperCase()}`);
      if (date_from || date_to) {
        const from = date_from ?? "1976-01-01";
        const to = date_to ?? new Date().toISOString().slice(0, 10);
        searchParts.push(`decision_date:[${from}+TO+${to}]`);
      }
    }

    const { data, url } = await queryOpenFDA("510k", searchParts, {
      limit: limit ?? 10,
      sort: k_number ? undefined : "decision_date:desc",
    });

    if (data.error) return { content: [{ type: "text" as const, text: formatError(data, url) }] };
    if (!data.results?.length) {
      return { content: [{ type: "text" as const, text: `No 510(k) records found.\n\n${formatFooter(url, data.meta)}` }] };
    }

    const total = data.meta?.results?.total ?? 0;
    const lines: string[] = [`Found ${total} 510(k) clearance(s).\n`];

    for (const r of data.results) {
      const kn = r.k_number as string;
      const decisionDate = normalizeDateResponse(r.decision_date as string);
      const receivedDate = normalizeDateResponse(r.date_received as string);
      const days = decisionDate && receivedDate ? daysBetween(receivedDate, decisionDate) : null;

      lines.push(`**${kn}** — ${r.device_name}`);
      lines.push(`  Applicant: ${r.applicant}`);
      lines.push(`  Decision: ${r.decision_description} | Type: ${r.clearance_type ?? "N/A"}`);
      lines.push(`  Decision date: ${decisionDate ?? "N/A"} | Received: ${receivedDate ?? "N/A"}${days !== null ? ` | Days to decision: ${days}` : ""}`);
      lines.push(`  Product code: ${r.product_code} | Panel: ${r.advisory_committee_description ?? r.advisory_committee}`);
      lines.push(`  Submission type: ${r.statement_or_summary ?? "N/A"}`);
      lines.push(`  FDA source: ${link510k(kn)}`);
      lines.push("");
    }

    lines.push(formatFooter(url, data.meta));
    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  }
);

// ─── Tool 3: search_pma ─────────────────────────────────────────────────────

server.tool(
  "search_pma",
  `Search FDA PMA (Premarket Approval) database for Class III medical devices. Best used with a product_code or specific pma_number. Returns approval details with FDA source links. Panel codes: ${PANEL_LIST}.`,
  {
    product_code: z.string().optional().describe("3-letter FDA product code"),
    pma_number: z.string().optional().describe("Specific PMA number (e.g., 'P170019')"),
    applicant: z.string().optional().describe("Company name (partial match)"),
    trade_name: z.string().optional().describe("Commercial product name"),
    advisory_committee: z.string().optional().describe("Panel code"),
    date_from: z.string().optional().describe("Decision date start (YYYY-MM-DD)"),
    date_to: z.string().optional().describe("Decision date end (YYYY-MM-DD)"),
    limit: z.number().min(1).max(50).optional().describe("Results to return (default 10)"),
  },
  async ({ product_code, pma_number, applicant, trade_name, advisory_committee, date_from, date_to, limit }) => {
    if (!product_code && !pma_number && !applicant && !trade_name) {
      return { content: [{ type: "text" as const, text: "Error: Provide at least one of product_code, pma_number, applicant, or trade_name." }] };
    }

    if (product_code) {
      const err = validateProductCode(product_code);
      if (err) return { content: [{ type: "text" as const, text: `Validation error: ${err}` }] };
    }
    if (pma_number && !PMA_NUMBER_RE.test(pma_number)) {
      return { content: [{ type: "text" as const, text: `Validation error: "${pma_number}" is not a valid PMA number. Format: P followed by 6 digits (e.g., P170019).` }] };
    }
    if (date_from) { const err = validateDate(date_from); if (err) return { content: [{ type: "text" as const, text: `Validation error (date_from): ${err}` }] }; }
    if (date_to) { const err = validateDate(date_to); if (err) return { content: [{ type: "text" as const, text: `Validation error (date_to): ${err}` }] }; }

    const searchParts: string[] = [];

    if (pma_number) {
      searchParts.push(`pma_number:${pma_number.toUpperCase()}`);
    } else {
      if (product_code) searchParts.push(`product_code:${product_code.toUpperCase()}`);
      if (applicant) searchParts.push(`applicant:"${applicant}"`);
      if (trade_name) searchParts.push(`trade_name:"${trade_name}"`);
      if (advisory_committee) searchParts.push(`advisory_committee:${advisory_committee.toUpperCase()}`);
      if (date_from || date_to) {
        const from = date_from ?? "1976-01-01";
        const to = date_to ?? new Date().toISOString().slice(0, 10);
        searchParts.push(`decision_date:[${from}+TO+${to}]`);
      }
    }

    const { data, url } = await queryOpenFDA("pma", searchParts, {
      limit: limit ?? 10,
      sort: pma_number ? undefined : "decision_date:desc",
    });

    if (data.error) return { content: [{ type: "text" as const, text: formatError(data, url) }] };
    if (!data.results?.length) {
      return { content: [{ type: "text" as const, text: `No PMA records found.\n\n${formatFooter(url, data.meta)}` }] };
    }

    const total = data.meta?.results?.total ?? 0;
    const lines: string[] = [`Found ${total} PMA record(s).\n`];

    for (const r of data.results) {
      const pn = r.pma_number as string;
      const supplement = r.supplement_number as string | undefined;
      const displayNumber = supplement ? `${pn}/${supplement}` : pn;
      const decisionDate = normalizeDateResponse(r.decision_date as string);

      lines.push(`**${displayNumber}** — ${r.trade_name ?? r.generic_name ?? "N/A"}`);
      lines.push(`  Generic name: ${r.generic_name ?? "N/A"}`);
      lines.push(`  Applicant: ${r.applicant}`);
      lines.push(`  Decision: ${r.decision_code} | Date: ${decisionDate ?? "N/A"}`);
      lines.push(`  Product code: ${r.product_code} | Panel: ${r.advisory_committee_description ?? r.advisory_committee}`);
      if (r.supplement_type) lines.push(`  Supplement type: ${r.supplement_type} | Reason: ${r.supplement_reason ?? "N/A"}`);
      lines.push(`  FDA source: ${linkPMA(pn)}`);
      lines.push("");
    }

    lines.push(formatFooter(url, data.meta));
    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  }
);

// ─── Tool 4: search_recalls ─────────────────────────────────────────────────

server.tool(
  "search_recalls",
  `Search FDA medical device recall database (2002+). Best used with a product_code. Note: recall severity classification (Class I/II/III) is not available from this endpoint — check the FDA source link for each recall to see severity on the FDA's page. Returns recall details with FDA source links.`,
  {
    product_code: z.string().optional().describe("3-letter FDA product code"),
    recalling_firm: z.string().optional().describe("Company name (partial match)"),
    status: z.enum(["Open", "Completed", "Terminated"]).optional().describe("Recall status"),
    date_from: z.string().optional().describe("Event initiation date start (YYYY-MM-DD)"),
    date_to: z.string().optional().describe("Event initiation date end (YYYY-MM-DD)"),
    limit: z.number().min(1).max(50).optional().describe("Results to return (default 10)"),
  },
  async ({ product_code, recalling_firm, status, date_from, date_to, limit }) => {
    if (!product_code && !recalling_firm) {
      return { content: [{ type: "text" as const, text: "Error: Provide at least one of product_code or recalling_firm." }] };
    }

    if (product_code) {
      const err = validateProductCode(product_code);
      if (err) return { content: [{ type: "text" as const, text: `Validation error: ${err}` }] };
    }
    if (date_from) { const err = validateDate(date_from); if (err) return { content: [{ type: "text" as const, text: `Validation error (date_from): ${err}` }] }; }
    if (date_to) { const err = validateDate(date_to); if (err) return { content: [{ type: "text" as const, text: `Validation error (date_to): ${err}` }] }; }

    const searchParts: string[] = [];
    if (product_code) searchParts.push(`product_code:${product_code.toUpperCase()}`);
    if (recalling_firm) searchParts.push(`recalling_firm:"${recalling_firm}"`);
    if (status) searchParts.push(`recall_status:"${status}"`);
    if (date_from || date_to) {
      const from = date_from ?? "2002-01-01";
      const to = date_to ?? new Date().toISOString().slice(0, 10);
      searchParts.push(`event_date_initiated:[${from}+TO+${to}]`);
    }

    const { data, url } = await queryOpenFDA("recall", searchParts, {
      limit: limit ?? 10,
      sort: "event_date_initiated:desc",
    });

    if (data.error) return { content: [{ type: "text" as const, text: formatError(data, url) }] };
    if (!data.results?.length) {
      return { content: [{ type: "text" as const, text: `No recall records found.\n\n${formatFooter(url, data.meta)}` }] };
    }

    const total = data.meta?.results?.total ?? 0;
    const lines: string[] = [`Found ${total} recall(s).\n`];

    for (const r of data.results) {
      const initiated = r.event_date_initiated as string | undefined;
      const posted = r.event_date_posted as string | undefined;
      const cfresId = r.cfres_id as string;
      const openfda = r.openfda as Record<string, unknown> | undefined;
      const kNumbers = (openfda?.k_number as string[] | undefined)?.slice(0, 5)?.join(", ");

      lines.push(`**Recall ${r.product_res_number ?? cfresId}** — ${r.recalling_firm}`);
      lines.push(`  Product: ${(r.product_description as string)?.slice(0, 200) ?? "N/A"}`);
      lines.push(`  Reason: ${(r.reason_for_recall as string)?.slice(0, 300) ?? "N/A"}`);
      if (r.root_cause_description) lines.push(`  Root cause: ${r.root_cause_description}`);
      lines.push(`  Status: ${r.recall_status} | Initiated: ${initiated ?? "N/A"} | Posted: ${posted ?? "N/A"}`);
      lines.push(`  Quantity: ${r.product_quantity ?? "N/A"} | Distribution: ${(r.distribution_pattern as string)?.slice(0, 150) ?? "N/A"}`);
      if (kNumbers) lines.push(`  Associated 510(k)s: ${kNumbers}`);
      lines.push(`  FDA source: ${linkRecall(cfresId)}`);
      lines.push("");
    }

    lines.push(formatFooter(url, data.meta));
    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  }
);

// ─── Tool 5: search_adverse_events ──────────────────────────────────────────

const MAUDE_CAVEAT = `MAUDE Advisory: This data contains unverified, self-reported adverse event reports. Inclusion does not establish that a device caused or contributed to the reported event. Reports may be incomplete, inaccurate, or duplicated. See FDA's MAUDE FAQ for interpretation guidance.\n`;

server.tool(
  "search_adverse_events",
  `Search FDA MAUDE (Manufacturer and User Facility Device Experience) database for adverse event reports. Returns curated fields only — not the full 80+ field record. IMPORTANT: MAUDE data contains unverified, self-reported information. Inclusion of a report does not establish causation. Reports may be incomplete, inaccurate, or duplicated. Always convey these caveats when presenting results to the user.`,
  {
    product_code: z.string().optional().describe("3-letter FDA product code"),
    brand_name: z.string().optional().describe("Device brand name"),
    manufacturer: z.string().optional().describe("Manufacturer name"),
    event_type: z.enum(["Death", "Injury", "Malfunction", "Other"]).optional().describe("Event type"),
    report_source: z.enum(["Manufacturer report", "Voluntary report", "User facility report", "Distributor report"]).optional().describe("Report source"),
    date_from: z.string().optional().describe("Date received start (YYYY-MM-DD)"),
    date_to: z.string().optional().describe("Date received end (YYYY-MM-DD)"),
    limit: z.number().min(1).max(50).optional().describe("Results to return (default 10)"),
  },
  async ({ product_code, brand_name, manufacturer, event_type, report_source, date_from, date_to, limit }) => {
    if (!product_code && !brand_name && !manufacturer) {
      return { content: [{ type: "text" as const, text: "Error: Provide at least one of product_code, brand_name, or manufacturer." }] };
    }

    if (product_code) {
      const err = validateProductCode(product_code);
      if (err) return { content: [{ type: "text" as const, text: `Validation error: ${err}` }] };
    }
    if (date_from) { const err = validateDate(date_from); if (err) return { content: [{ type: "text" as const, text: `Validation error (date_from): ${err}` }] }; }
    if (date_to) { const err = validateDate(date_to); if (err) return { content: [{ type: "text" as const, text: `Validation error (date_to): ${err}` }] }; }

    const searchParts: string[] = [];
    if (product_code) searchParts.push(`device.device_report_product_code:${product_code.toUpperCase()}`);
    if (brand_name) searchParts.push(`device.brand_name:"${brand_name}"`);
    if (manufacturer) searchParts.push(`device.manufacturer_d_name:"${manufacturer}"`);
    if (event_type) searchParts.push(`event_type:"${event_type}"`);
    if (report_source) searchParts.push(`report_source_code:"${report_source}"`);
    if (date_from || date_to) {
      const from = stripDashes(date_from ?? "2000-01-01");
      const to = stripDashes(date_to ?? new Date().toISOString().slice(0, 10));
      searchParts.push(`date_received:[${from}+TO+${to}]`);
    }

    const { data, url } = await queryOpenFDA("event", searchParts, {
      limit: limit ?? 10,
      sort: "date_received:desc",
    });

    if (data.error) return { content: [{ type: "text" as const, text: `${MAUDE_CAVEAT}\n${formatError(data, url)}` }] };
    if (!data.results?.length) {
      return { content: [{ type: "text" as const, text: `${MAUDE_CAVEAT}\nNo adverse event records found.\n\n${formatFooter(url, data.meta)}` }] };
    }

    const total = data.meta?.results?.total ?? 0;
    const lines: string[] = [MAUDE_CAVEAT, `Found ${total} adverse event report(s).\n`];

    for (const r of data.results) {
      const devices = r.device as Record<string, unknown>[] | undefined;
      const device = devices?.[0] ?? {};
      const patients = r.patient as Record<string, unknown>[] | undefined;
      const patient = patients?.[0];
      const mdrTexts = r.mdr_text as Record<string, unknown>[] | undefined;
      const eventDesc = mdrTexts?.find((t) => t.text_type_code === "Description of Event or Problem");

      const dateOfEvent = normalizeDateResponse(r.date_of_event as string);
      const dateReceived = normalizeDateResponse(r.date_received as string);
      const patientOutcome = patient
        ? ((patient.sequence_number_outcome as string[]) ?? []).join(", ").trim()
        : "N/A";
      const mdrKey = r.mdr_report_key as string;

      lines.push(`**${r.report_number}** — ${r.event_type}`);
      lines.push(`  Device: ${device.brand_name ?? "N/A"} (${device.generic_name ?? "N/A"})`);
      lines.push(`  Manufacturer: ${device.manufacturer_d_name ?? "N/A"} | Model: ${device.model_number ?? "N/A"}`);
      lines.push(`  Product code: ${device.device_report_product_code ?? "N/A"}`);
      lines.push(`  Date of event: ${dateOfEvent ?? "N/A"} | Date received: ${dateReceived ?? "N/A"}`);
      lines.push(`  Patient outcome: ${patientOutcome || "N/A"}`);
      lines.push(`  Report source: ${r.report_source_code ?? "N/A"}`);
      if (eventDesc) {
        const text = (eventDesc.text as string)?.slice(0, 400) ?? "";
        lines.push(`  Description: ${text}${text.length >= 400 ? "..." : ""}`);
      }
      lines.push(`  FDA source: ${linkMAUDE(mdrKey)}`);
      lines.push("");
    }

    lines.push(formatFooter(url, data.meta));
    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  }
);

// ─── Start Server ────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
