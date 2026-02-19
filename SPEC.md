# FDA Devices MCP Server — v1 Spec

## Overview

An MCP server that wraps the [openFDA Device APIs](https://open.fda.gov/apis/device/) into 5 tools for regulatory due diligence. Claude interprets user questions and calls the appropriate tools with structured parameters. Every response includes FDA source links for verification.

**No API key required.** openFDA is public and free. No auth, no env vars.

## Stack

- **Runtime:** Bun + TypeScript
- **Dependencies:** `@modelcontextprotocol/sdk`, `zod`
- **Structure:** Single `index.ts` file (~400 lines)
- **Location:** `~/Documents/Projects/06-mcp-servers/fda-devices/`

## Architecture

```
User question (natural language)
  → Claude (interprets, picks tools, sets params)
    → MCP Tool (validates input, builds query, hits openFDA)
      → openFDA API (returns JSON)
    → MCP Tool (formats response, adds source links, returns)
  → Claude (synthesizes answer, cites sources)
  → User sees answer with FDA.gov verification links
```

The MCP is stateless. No caching, no database, no local storage.

---

## API Client Layer

### Base URL

```
https://api.fda.gov/device/{endpoint}.json
```

### Endpoints Used

| Endpoint | openFDA Path | Data |
|----------|-------------|------|
| Classification | `classification.json` | Product codes, device class, regulation numbers |
| 510(k) | `510k.json` | Premarket notification clearances (1976+) |
| PMA | `pma.json` | Premarket approval applications, Class III |
| Recalls | `recall.json` | Device recalls (2002+) |
| Adverse Events | `event.json` | MAUDE reports |

### Query Syntax

```
?search=field:term+AND+field:term&limit=10&skip=0
```

- **AND:** `field:term+AND+field:term`
- **OR:** `field:term+field:term`
- **Date range:** `field:[{date}+TO+{date}]` (format varies by endpoint — see Date Handling)
- **Count:** `?count=field.exact` (aggregation)
- **Sort:** `?sort=field:desc`
- **Limit:** max 1000 per call
- **Skip:** for pagination (skip + limit capped at ~26,000)

### Date Handling

**Date formats are inconsistent across openFDA endpoints:**

| Endpoint | Stored Format | Date Range Query Format | Example |
|----------|--------------|------------------------|---------|
| 510(k) | `YYYY-MM-DD` | `[YYYY-MM-DD+TO+YYYY-MM-DD]` | `decision_date:[2024-01-01+TO+2024-12-31]` |
| PMA | `YYYY-MM-DD` | `[YYYY-MM-DD+TO+YYYY-MM-DD]` | `decision_date:[2024-01-01+TO+2024-12-31]` |
| Recalls | `YYYY-MM-DD` | `[YYYY-MM-DD+TO+YYYY-MM-DD]` | `event_date_initiated:[2024-01-01+TO+2024-12-31]` |
| Adverse Events | `YYYYMMDD` | `[YYYYMMDD+TO+YYYYMMDD]` | `date_received:[20240101+TO+20241231]` |

The MCP:
- Accepts `YYYY-MM-DD` from the user (always)
- Converts to the endpoint's native format for queries (strip dashes for adverse events)
- Returns `YYYY-MM-DD` in all responses (normalize adverse event dates)
- Computes derived date fields (e.g., `days_to_decision`) correctly

### Error Handling

| Scenario | Behavior |
|----------|----------|
| **No results (empty `results` array)** | Return: "No records found for [query]. Verify at [FDA source link]." |
| **API error 429 (rate limit)** | Return: "openFDA rate limit reached (240 req/min). Try again shortly." |
| **API error 400 (bad query)** | Surface the API error message to Claude, don't swallow it |
| **Network error** | Return: "Unable to reach openFDA API. Check connectivity." |
| **Invalid input** | Caught before API call — return validation error with guidance |

### Response Envelope

Every tool response includes:

```typescript
{
  content: [{
    type: "text",
    text: `[header line — result count + query summary]

[formatted records]

---
Query: {full openFDA API URL used}
Data source: openFDA (last updated: {meta.last_updated})
Disclaimer: openFDA data is unvalidated. Verify on FDA.gov before making regulatory decisions.`
  }]
}
```

The `Query` line contains the exact API URL used (e.g., `https://api.fda.gov/device/510k.json?search=product_code:DXN&sort=decision_date:desc&limit=10`). This allows a regulatory professional to:
- Reproduce the query independently
- Cite the data source in official documentation
- Verify results directly in a browser
```

---

## Input Validation

Applied before any API call. Catches common mistakes.

```typescript
// Patterns
const K_NUMBER = /^K\d{6,7}$/i;       // e.g., K032161
const PMA_NUMBER = /^P\d{6}$/i;        // e.g., P170019
const PRODUCT_CODE = /^[A-Z]{3}$/i;    // e.g., DXN
const DATE = /^\d{4}-\d{2}-\d{2}$/;    // e.g., 2024-01-15

// Smart routing: detect input type mismatches
// If a K-number is passed as product_code → helpful error:
// "K032161 looks like a 510(k) number, not a product code.
//  Use classify_device to find the product code, or search_510k
//  with k_number parameter."
```

---

## Source Links

Every record includes a direct link to the canonical FDA page. These are verified working URL patterns:

| Record Type | URL Pattern | ID Field |
|-------------|------------|----------|
| **510(k)** | `https://www.accessdata.fda.gov/scripts/cdrh/cfdocs/cfpmn/pmn.cfm?ID={k_number}` | `k_number` |
| **PMA** | `https://www.accessdata.fda.gov/scripts/cdrh/cfdocs/cfpma/pma.cfm?id={pma_number}` | `pma_number` |
| **Classification** | `https://www.accessdata.fda.gov/scripts/cdrh/cfdocs/cfpcd/classification.cfm?ID={product_code}` | `product_code` |
| **Recall** | `https://www.accessdata.fda.gov/scripts/cdrh/cfdocs/cfres/res.cfm?id={cfres_id}` | `cfres_id` |
| **Adverse Event** | `https://www.accessdata.fda.gov/scripts/cdrh/cfdocs/cfmaude/detail.cfm?mdrfoi__id={mdr_report_key}` | `mdr_report_key` |
| **eCFR Regulation** | `https://www.ecfr.gov/current/title-21/chapter-I/subchapter-H/part-{part}/section-{regulation_number}` | `regulation_number` |

---

## Tools (5)

### 1. `classify_device`

**Purpose:** Identify the regulatory classification of a device. The starting point for all regulatory research.

**Tool description (shown to Claude):**
> Look up FDA device classification by product code or device name. Returns product code, device class (I/II/III), regulation number, and regulatory details. FDA uses formal names like "Electrocardiograph, Ambulatory" not "wearable ECG patch" — try generic medical terms. If no results, try shorter/broader terms. Use this tool first to find the product code, then use other tools with that code. Advisory committee (panel) codes: AN=Anesthesiology, CV=Cardiovascular, CH=Clinical Chemistry, DE=Dental, EN=Ear/Nose/Throat, GU=Gastroenterology/Urology, HO=General Hospital, HE=Hematology, IM=Immunology, MI=Microbiology, NE=Neurology, OB=Obstetrics/Gynecology, OP=Ophthalmic, OR=Orthopedic, PA=Pathology, PM=Physical Medicine, RA=Radiology, SU=General/Plastic Surgery, TX=Clinical Toxicology.

**Parameters:**

| Param | Type | Required | Description |
|-------|------|:--------:|-------------|
| `product_code` | string | No | Exact 3-letter FDA product code (e.g., "DXN"). If provided, does direct lookup — fastest and most accurate path. |
| `query` | string | No | Device name or description to search for. Searched against device_name and definition fields. |
| `device_class` | string | No | Filter by class: "1", "2", or "3" |
| `limit` | number | No | Results to return (default 10, max 50) |

At least one of `product_code` or `query` is required.

**Search strategy:**
1. If `product_code` provided → direct lookup: `search=product_code:{code}` (exact, fast)
2. If `query` provided → multi-pass search:
   - **Pass 1:** `search=device_name:{query}` (unquoted — matches individual terms anywhere in device_name)
     - e.g., `device_name:pulse+AND+device_name:oximeter` matches both "Oximeter, Pulse" AND "Pulse Oximeter For Over-The-Counter Use"
     - Multi-word queries: split on spaces, join each term with `+AND+device_name:` to require all terms
   - **Pass 2 (if zero results):** `search=definition:{query}` (same term-splitting strategy on definition text)
   - **Pass 3 (if still zero results and query has 3+ words):** Broaden by dropping the last word and retrying Pass 1. Repeat until results are found or only 1 word remains. For "blood pressure monitor": try "blood pressure" (2 terms) → finds DXN and 9 others. This handles cases where the FDA name doesn't contain all user terms (e.g., "System, Measurement, Blood-Pressure, Non-Invasive" has no "monitor").

   **Implementation:** Simple loop — `terms = query.split(' '); while (terms.length > 1 && noResults) { terms.pop(); retry; }`

   **Why unquoted, not quoted:** Quoted search (`"pulse oximeter"`) requires exact phrase match. FDA device names use inverted format ("Oximeter, Pulse" not "Pulse Oximeter"), so phrase search misses the most common product codes. Unquoted term search matches regardless of word order.

   **Why AND per term, not bare terms:** Bare multi-word search (`device_name:pulse+oximeter`) is ambiguous — the second term may search across all fields, not just device_name. Explicit AND (`device_name:pulse+AND+device_name:oximeter`) ensures both terms are required in the device_name field.

**Returns per record:**
- `product_code` — 3-letter code
- `device_name` — FDA formal name
- `device_class` — "1", "2", or "3"
- `regulation_number` — CFR reference (e.g., "870.2710")
- `medical_specialty` — Panel code (e.g., "CV")
- `medical_specialty_description` — Full panel name
- `definition` — FDA definition text
- `implant_flag` — "Y" or "N"
- `life_sustain_support_flag` — "Y" or "N"
- `gmp_exempt_flag` — "Y" or "N"
- `submission_type_id` — Submission pathway
- `third_party_flag` — Third-party review eligible
- `review_panel` — Review panel assignment
- `source_url` — FDA AccessData classification page link
- `ecfr_url` — eCFR regulation link

---

### 2. `search_510k`

**Purpose:** Search 510(k) premarket notification clearances. Primary use: finding predicate devices.

**Tool description (shown to Claude):**
> Search FDA 510(k) clearance database. Best used with a product_code from classify_device, or a specific k_number for direct lookup. Company names vary in FDA data ("Medtronic" vs "Medtronic, Inc." vs "MEDTRONIC INC") — try partial names. Returns clearance details with FDA source links.

**Parameters:**

| Param | Type | Required | Description |
|-------|------|:--------:|-------------|
| `product_code` | string | No | 3-letter FDA product code |
| `k_number` | string | No | Specific 510(k) number (e.g., "K032161") — direct lookup |
| `applicant` | string | No | Company name (partial match supported) |
| `device_name` | string | No | Device name search |
| `decision` | string | No | Decision code: "SESE" (substantially equivalent), "SEKN" (not SE), "SESD" (SE with limitations) |
| `clearance_type` | string | No | "Traditional", "Special", or "Abbreviated" |
| `advisory_committee` | string | No | Panel code (e.g., "CV", "SU", "OR") |
| `date_from` | string | No | Decision date start (YYYY-MM-DD) |
| `date_to` | string | No | Decision date end (YYYY-MM-DD) |
| `limit` | number | No | Results to return (default 10, max 50) |

At least one of `product_code`, `k_number`, `applicant`, or `device_name` is required.

**Query construction:**
- `k_number` → `search=k_number:{value}` (direct lookup, ignores other filters; normalize to uppercase)
- `product_code` → `search=product_code:{value}` (+ additional AND filters)
- `applicant` → `search=applicant:"{value}"` (quoted — openFDA matches records containing this phrase within the applicant field; case-insensitive; e.g., `"Boston Scientific"` matches "Boston Scientific Scimed, Inc.")
- `device_name` → `search=device_name:"{value}"` (quoted phrase search)
- `decision` → `+AND+decision_code:{value}`
- `clearance_type` → `+AND+clearance_type:"{value}"`
- `advisory_committee` → `+AND+advisory_committee:{value}`
- Date range → `+AND+decision_date:[{from}+TO+{to}]`
- Results sorted by `decision_date:desc` (most recent first, verified working)

**Returns per record:**
- `k_number` — 510(k) identifier
- `device_name` — Device name
- `applicant` — Company name
- `decision_date` — Formatted YYYY-MM-DD
- `date_received` — Formatted YYYY-MM-DD
- `days_to_decision` — **Computed:** decision_date minus date_received (integer)
- `decision_description` — "Substantially Equivalent" etc.
- `clearance_type` — Traditional / Special / Abbreviated
- `product_code` — 3-letter code
- `advisory_committee_description` — Panel name
- `statement_or_summary` — "Summary" or "Statement"
- `source_url` — FDA AccessData 510(k) page link
- `total_results` — Total matching records (from meta)

---

### 3. `search_pma`

**Purpose:** Search premarket approval applications for Class III devices.

**Tool description (shown to Claude):**
> Search FDA PMA (Premarket Approval) database for Class III medical devices. Best used with a product_code or specific pma_number. Returns approval details with FDA source links.

**Parameters:**

| Param | Type | Required | Description |
|-------|------|:--------:|-------------|
| `product_code` | string | No | 3-letter FDA product code |
| `pma_number` | string | No | Specific PMA number (e.g., "P170019") — direct lookup |
| `applicant` | string | No | Company name (partial match) |
| `trade_name` | string | No | Commercial product name |
| `advisory_committee` | string | No | Panel code |
| `date_from` | string | No | Decision date start (YYYY-MM-DD) |
| `date_to` | string | No | Decision date end (YYYY-MM-DD) |
| `limit` | number | No | Results to return (default 10, max 50) |

At least one of `product_code`, `pma_number`, `applicant`, or `trade_name` is required.

**Query construction:**
- `pma_number` → `search=pma_number:{value}` (direct lookup; normalize to uppercase)
- `product_code` → `search=product_code:{value}` (+ AND filters)
- `applicant` → `+AND+applicant:"{value}"` (quoted, case-insensitive)
- `trade_name` → `+AND+trade_name:"{value}"` (quoted)
- `advisory_committee` → `+AND+advisory_committee:{value}`
- Date range → `+AND+decision_date:[{from}+TO+{to}]`
- Results sorted by `decision_date:desc`

**Returns per record:**
- `pma_number` — PMA identifier
- `supplement_number` — Supplement ID (if applicable)
- `trade_name` — Commercial name
- `generic_name` — Generic device name
- `applicant` — Company name
- `decision_date` — Formatted YYYY-MM-DD
- `decision_code` — FDA decision
- `product_code` — 3-letter code
- `advisory_committee_description` — Panel name
- `supplement_type` — Type of supplement (if applicable)
- `supplement_reason` — Reason for supplement (if applicable)
- `source_url` — FDA AccessData PMA page link
- `total_results` — Total matching records

---

### 4. `search_recalls`

**Purpose:** Search medical device recalls for safety signal research.

**Tool description (shown to Claude):**
> Search FDA medical device recall database (2002+). Best used with a product_code. Returns recall details including reason, root cause, status, and quantities affected. Note: recall severity classification (Class I/II/III) is NOT available when searching by product code — it exists only in the enforcement endpoint which lacks reliable product code indexing. The FDA AccessData source link for each recall contains the full severity classification. Returns recall details with FDA source links.

**Parameters:**

| Param | Type | Required | Description |
|-------|------|:--------:|-------------|
| `product_code` | string | No | 3-letter FDA product code |
| `recalling_firm` | string | No | Company name (partial match) |
| `status` | string | No | "Open", "Completed", or "Terminated" |
| `date_from` | string | No | Event initiation date start (YYYY-MM-DD) |
| `date_to` | string | No | Event initiation date end (YYYY-MM-DD) |
| `limit` | number | No | Results to return (default 10, max 50) |

At least one of `product_code` or `recalling_firm` is required.

**Query construction (uses recall endpoint only — `device/recall.json`):**
- `product_code` → `search=product_code:{value}`
- `recalling_firm` → `search=recalling_firm:"{value}"`
- `status` → `+AND+recall_status:"{value}"`
- Date range uses `event_date_initiated` field: `+AND+event_date_initiated:[{from}+TO+{to}]`
- Results sorted by `event_date_initiated:desc`

**Why not the enforcement endpoint?** The enforcement endpoint (`device/enforcement.json`) has recall severity classification (Class I/II/III) but its `openfda` object is frequently empty — product code search is unreliable. The recall endpoint has `product_code` as a direct, reliable searchable field. For severity classification, the FDA AccessData source link (included in every record) shows the full classification on the FDA's own page.

**Returns per record:**
- `product_description` — What was recalled
- `recalling_firm` — Company name
- `reason_for_recall` — Why it was recalled
- `root_cause_description` — Root cause (when available)
- `event_date_initiated` — Formatted YYYY-MM-DD
- `event_date_posted` — When FDA posted it
- `recall_status` — Open / Completed / Terminated
- `product_quantity` — Number of units affected
- `distribution_pattern` — Where the product was distributed
- `code_info` — Lot/serial numbers
- `cfres_id` — Recall event ID
- `k_numbers` — Associated 510(k) numbers (from openfda)
- `source_url` — FDA AccessData recall page link (contains full recall classification)
- `total_results` — Total matching records

---

### 5. `search_adverse_events`

**Purpose:** Search MAUDE adverse event reports. Used for safety signal screening during due diligence.

**Tool description (shown to Claude):**
> Search FDA MAUDE (Manufacturer and User Facility Device Experience) database for adverse event reports. Returns curated fields only — not the full 80+ field record. IMPORTANT: MAUDE data contains unverified, self-reported information. Inclusion of a report does not establish causation. Reports may be incomplete, inaccurate, or duplicated. Always convey these caveats when presenting results to the user.

**Parameters:**

| Param | Type | Required | Description |
|-------|------|:--------:|-------------|
| `product_code` | string | No | 3-letter FDA product code (searches `device.device_report_product_code`) |
| `brand_name` | string | No | Device brand name (searches `device.brand_name`) |
| `manufacturer` | string | No | Manufacturer name (searches `device.manufacturer_d_name`) |
| `event_type` | string | No | "Death", "Injury", "Malfunction", or "Other" |
| `report_source` | string | No | "Manufacturer report", "Voluntary report", "User facility report", or "Distributor report" |
| `date_from` | string | No | Date received start (YYYY-MM-DD) |
| `date_to` | string | No | Date received end (YYYY-MM-DD) |
| `limit` | number | No | Results to return (default 10, max 50) |

At least one of `product_code`, `brand_name`, or `manufacturer` is required.

**Query construction:**
- `product_code` → `search=device.device_report_product_code:{value}` (nested under device array)
- `brand_name` → `search=device.brand_name:"{value}"`
- `manufacturer` → `search=device.manufacturer_d_name:"{value}"`
- `event_type` → `+AND+event_type:"{value}"`
- `report_source` → `+AND+report_source_code:"{value}"`
- Date range uses `date_received`: `+AND+date_received:[{from}+TO+{to}]` (dates must be YYYYMMDD format — strip dashes from user input)
- Results sorted by `date_received:desc`

**Returns per record (curated — only these fields):**
- `report_number` — MDR report number
- `event_type` — Death / Injury / Malfunction / Other
- `date_of_event` — Formatted YYYY-MM-DD (when available)
- `date_received` — Formatted YYYY-MM-DD
- `brand_name` — From `device[0].brand_name`
- `generic_name` — From `device[0].generic_name`
- `manufacturer` — From `device[0].manufacturer_d_name`
- `model_number` — From `device[0].model_number`
- `product_code` — From `device[0].device_report_product_code`
- `patient_outcome` — From `patient[0].sequence_number_outcome` (flattened to comma-separated string)
- `event_description` — From `mdr_text[]` where `text_type_code = "Description of Event or Problem"` (first match only)
- `report_source` — From `report_source_code`
- `source_url` — FDA MAUDE detail page link
- `total_results` — Total matching records

**Mandatory caveat** prepended to every response:

```
MAUDE Advisory: This data contains unverified, self-reported adverse event
reports. Inclusion does not establish that a device caused or contributed to
the reported event. Reports may be incomplete, inaccurate, or duplicated.
See FDA's MAUDE FAQ for interpretation guidance.
```

---

## Field Path Reference

Quick reference for the exact openFDA field paths used in queries:

### Classification (`device/classification.json`)
```
product_code, device_name, device_class, regulation_number,
medical_specialty, medical_specialty_description, definition,
implant_flag, life_sustain_support_flag, gmp_exempt_flag,
third_party_flag, review_panel, submission_type_id
```

### 510(k) (`device/510k.json`)
```
k_number, device_name, applicant, product_code,
decision_date, date_received, decision_code, decision_description,
clearance_type, advisory_committee, advisory_committee_description,
statement_or_summary, country_code
```

### PMA (`device/pma.json`)
```
pma_number, trade_name, generic_name, applicant, product_code,
decision_date, decision_code, advisory_committee,
advisory_committee_description, supplement_number,
supplement_type, supplement_reason
```

### Recalls (`device/recall.json`)
```
product_description, recalling_firm, reason_for_recall,
root_cause_description, event_date_initiated, event_date_posted,
recall_status, product_quantity, distribution_pattern,
code_info, cfres_id, product_code, product_res_number,
openfda.k_number
```

### Adverse Events (`device/event.json`)
```
report_number, event_type, date_of_event, date_received,
report_source_code, mdr_report_key,
device[].brand_name, device[].generic_name,
device[].manufacturer_d_name, device[].model_number,
device[].device_report_product_code,
patient[].sequence_number_outcome,
mdr_text[].text, mdr_text[].text_type_code
```

---

## Configuration

### Claude Code

```json
// ~/.claude/settings.json → mcpServers
{
  "fda-devices": {
    "command": "bun",
    "args": ["run", "/Users/prahlaad/Documents/Projects/06-mcp-servers/fda-devices/index.ts"]
  }
}
```

### Claude Desktop

```json
// ~/Library/Application Support/Claude/claude_desktop_config.json → mcpServers
{
  "fda-devices": {
    "command": "bun",
    "args": ["run", "/Users/prahlaad/Documents/Projects/06-mcp-servers/fda-devices/index.ts"]
  }
}
```

---

## File Structure

```
~/Documents/Projects/06-mcp-servers/fda-devices/
├── index.ts          # MCP server — single file, all 5 tools
├── package.json      # deps: @modelcontextprotocol/sdk, zod
├── tsconfig.json
└── SPEC.md           # This file
```

---

## Out of Scope (v1)

These are intentionally excluded from the first version:

| Feature | Reason |
|---------|--------|
| PDF fetching & analysis (predicate extraction) | Option B enhancement — adds latency and complexity |
| De Novo specific endpoint | openFDA doesn't have one; de novos are in classification data |
| UDI lookups | Niche use case, add if needed |
| Registration/listing queries | Rarely needed for due diligence |
| Enforcement endpoint | Has recall severity but `openfda` object is frequently empty — can't search by product code reliably |
| Count/aggregation tool | Aggregate numbers without context can mislead |
| Company overview tool | Cross-endpoint synthesis risks inaccurate characterization |
| Compare tool | v2 feature |
| Caching | Stateless is simpler and avoids stale data |
| API key support | Not required; rate limit (240 req/min) is sufficient for conversational use |

---

## Known Limitations

1. **openFDA data is unvalidated.** Every endpoint carries the disclaimer: "Do not rely on openFDA to make decisions regarding medical care."

2. **Update frequency varies.** 510(k)/PMA: monthly. Recalls/events: weekly. Classification: irregular. The `meta.last_updated` field reflects this.

3. **No predicate device data.** openFDA does not include which device(s) were used as predicates in 510(k) submissions. This data only exists in unstructured PDF summaries.

4. **Company name inconsistency.** FDA data has no canonical company names. "Medtronic", "Medtronic, Inc.", "MEDTRONIC INC", and "Medtronic plc" are all different strings. Partial text search helps but isn't perfect.

5. **Adverse event data quality.** MAUDE reports are unverified, self-reported, and frequently duplicated. Absence of reports does not mean absence of problems, and presence of reports does not establish causation.

6. **Pagination ceiling.** openFDA caps skip + limit at approximately 26,000. For product codes with more submissions than this, not all records are accessible via the API.

7. **No free-text search across all fields.** Each search parameter targets specific fields. There is no "search everything" option — this is intentional to prevent garbage results.

8. **FDA naming conventions are inverted.** Device names use format "Noun, Modifier" (e.g., "Oximeter, Pulse" not "Pulse Oximeter"). The classify_device search strategy handles this with unquoted term-based search, but users should be aware results may use unfamiliar names.

9. **Sort may not be available on all endpoints.** Verified working on 510(k) (`decision_date:desc`). If sort fails on an endpoint, fall back to unsorted results and note this in the response.

10. **Recall severity classification not available by product code.** The enforcement endpoint has Class I/II/III severity but can't be reliably searched by product code (empty `openfda` objects). The recall endpoint has product code search but no severity. Each recall record includes an FDA source link where severity is visible on the FDA's own page.

---

## Appendix: Advisory Committee (Panel) Codes

These are the review panel codes used in `advisory_committee` parameters:

| Code | Panel Name |
|------|-----------|
| AN | Anesthesiology |
| CV | Cardiovascular |
| CH | Clinical Chemistry |
| DE | Dental |
| EN | Ear, Nose, Throat |
| GU | Gastroenterology, Urology |
| HO | General Hospital |
| HE | Hematology |
| IM | Immunology |
| MI | Microbiology |
| NE | Neurology |
| OB | Obstetrics/Gynecology |
| OP | Ophthalmic |
| OR | Orthopedic |
| PA | Pathology |
| PM | Physical Medicine |
| RA | Radiology |
| SU | General, Plastic Surgery |
| TX | Clinical Toxicology |

Include this mapping in tool descriptions so Claude can translate user terms like "cardiac devices" → `advisory_committee: "CV"`.
