# FDA Devices MCP Server

An MCP server that wraps the public [openFDA Device APIs](https://open.fda.gov/apis/device/) into 5 tools for medical device regulatory research. No API key required.

Ask Claude natural language questions about FDA device classification, 510(k) clearances, PMA approvals, recalls, and adverse events — and get structured results with source links.

## Install

Requires [Bun](https://bun.sh/) runtime.

```bash
# Clone and install
git clone https://github.com/prahlaadr/fda-devices-mcp.git
cd fda-devices-mcp
bun install

# Add to Claude Code
claude mcp add fda-devices bun run $(pwd)/index.ts --scope user

# Restart Claude Code
```

## Tools

| Tool | Purpose | Key Inputs |
|------|---------|------------|
| `classify_device` | Find product code, device class, regulation number | `query` or `product_code` |
| `search_510k` | Find 510(k) clearances / predicate devices | `product_code`, `k_number`, `applicant` |
| `search_pma` | Find PMA approvals (Class III) | `product_code`, `pma_number`, `applicant` |
| `search_recalls` | Find device recalls | `product_code`, `recalling_firm` |
| `search_adverse_events` | Search MAUDE adverse event reports | `product_code`, `brand_name`, `manufacturer` |

## Example Queries

Ask Claude directly — it picks the right tool(s):

- "What class is a pulse oximeter?"
- "I'm building a wearable ECG patch — what's my regulatory pathway?"
- "Find recent 510(k)s for blood pressure monitors"
- "Has Philips had any device recalls lately?"
- "Show me adverse events for Intuitive Surgical da Vinci"
- "What product code is AI radiology software?"
- "Look up 510(k) K250507"

### AI/SaMD Device Search

The `classify_device` tool has built-in support for AI and Software as a Medical Device queries. It maps informal terms to FDA's formal classification names and uses 510(k) device names as a bridge when classification search alone isn't enough.

| You ask | It finds |
|---------|----------|
| "wearable ECG patch" | MWJ — Electrocardiograph, Ambulatory |
| "surgical robot" | NAY — Computer Controlled Instrument |
| "fracture detection AI" | QBS — Radiological CAD Software For Fracture |
| "GI polyp detection AI" | QNP — Gastrointestinal Lesion Software Detection |
| "low ejection fraction ECG AI" | QLL — LV Ejection Fraction Screening Tool |
| "HeartFlow" | PJA — Coronary Vascular Physiologic Simulation Software |
| "Aidoc BriefCase" | QAS — Radiological Computer-Assisted Triage Software |

## How It Works

### Search Strategy (classify_device)

FDA uses formal inverted names ("Oximeter, Pulse" not "pulse oximeter") and many AI/SaMD devices are classified under generic product codes. The tool handles this with:

1. **Synonym expansion** — Maps ~60 common terms to FDA formal names (ECG → electrocardiograph, robot → computer controlled instrument, OCT → optical coherence tomography, etc.)
2. **Combinatorial broadening** — Tries all term subsequences ordered by length, prioritizing 2-3 term combos (the sweet spot for FDA names)
3. **Parallel field search** — Searches both `device_name` and `definition` fields at each step
4. **Relevance scoring** — Prevents low-relevance matches from short-circuiting the search
5. **510(k) bridge fallback** — When classification search fails, searches 510(k) device names to discover product codes, then looks those up in classification
6. **Smart failure messages** — When AI/SaMD queries fail entirely, suggests common product codes (QIH, QDQ, MYN, etc.)

### Every Response Includes

- The exact API query URL (reproducible, citable)
- FDA AccessData source links per record
- `meta.last_updated` from openFDA
- FDA disclaimer

### Source Links

| Type | Example |
|------|---------|
| 510(k) | `accessdata.fda.gov/.../cfpmn/pmn.cfm?ID=K032161` |
| PMA | `accessdata.fda.gov/.../cfpma/pma.cfm?id=P170019` |
| Classification | `accessdata.fda.gov/.../cfpcd/classification.cfm?ID=DXN` |
| Recall | `accessdata.fda.gov/.../cfres/res.cfm?id=212811` |
| MAUDE | `accessdata.fda.gov/.../cfmaude/detail.cfm?mdrfoi__id=19151705` |
| eCFR | `ecfr.gov/current/title-21/.../section-870.2700` |

## Design Decisions

- **URL construction** — Built manually, not via URLSearchParams. URLSearchParams encodes `+` as `%2B` which breaks openFDA's `+AND+` syntax.
- **Date formats** — Inconsistent across endpoints (510k/PMA/Recalls use `YYYY-MM-DD`, adverse events use `YYYYMMDD`). Tool accepts `YYYY-MM-DD` always, converts internally.
- **Recall severity gap** — Recall endpoint has no severity classification. Source link included where severity is visible on FDA's page.
- **MAUDE caveats** — Every adverse event response includes mandatory caveat about unverified, self-reported nature of data.

## Limitations

- No predicate device extraction (requires PDF parsing of 510(k) summary documents)
- Some AI/SaMD devices have brand names with zero keyword overlap to their classification (e.g., "SKOUT system" → QNP)
- Rate limited to 240 requests/min by openFDA (no API key)
- Classification database has ~6,000 generic categories — very specific queries may need the 510(k) bridge

## Tech Stack

- TypeScript, single file (`index.ts`)
- [Bun](https://bun.sh/) runtime
- [@modelcontextprotocol/sdk](https://www.npmjs.com/package/@modelcontextprotocol/sdk)
- [Zod](https://zod.dev/) for input validation
- No API key, no env vars, no database
