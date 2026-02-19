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

    // Multi-pass query search
    const terms = query!.trim().split(/\s+/);

    // Pass 1: device_name with all terms (AND), broadening by dropping last term
    let currentTerms = [...terms];
    while (currentTerms.length > 0) {
      const searchParts = [buildSearchTerms("device_name", currentTerms.join(" "))];
      if (device_class) searchParts.push(`device_class:${device_class}`);

      const { data, url } = await queryOpenFDA("classification", searchParts, { limit: resultLimit });

      if (!data.error && data.results && data.results.length > 0) {
        return { content: [{ type: "text" as const, text: formatClassificationResults(data, url) }] };
      }

      if (currentTerms.length > 1) {
        currentTerms.pop();
      } else {
        break;
      }
    }

    // Pass 2: definition field with all original terms, broadening
    currentTerms = [...terms];
    while (currentTerms.length > 0) {
      const searchParts = [buildSearchTerms("definition", currentTerms.join(" "))];
      if (device_class) searchParts.push(`device_class:${device_class}`);

      const { data, url } = await queryOpenFDA("classification", searchParts, { limit: resultLimit });

      if (!data.error && data.results && data.results.length > 0) {
        return { content: [{ type: "text" as const, text: formatClassificationResults(data, url) }] };
      }

      if (currentTerms.length > 1) {
        currentTerms.pop();
      } else {
        break;
      }
    }

    // Nothing found
    const fallbackUrl = `${BASE_URL}/classification.json?search=${buildSearchTerms("device_name", query!)}&limit=1`;
    return {
      content: [{
        type: "text" as const,
        text: `No classification results found for "${query}". Try shorter or broader medical terms. FDA uses formal names like "Oximeter, Pulse" not "pulse oximeter".\n\n${formatFooter(fallbackUrl)}`,
      }],
    };
  }
);

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
