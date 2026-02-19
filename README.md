# FDA Devices MCP Server — Handoff Doc

**Date:** 2026-02-19
**Location:** `~/Documents/Projects/06-mcp-servers/fda-devices/`
**Status:** Built, tested against live API, not yet activated in Claude Code

---

## What This Is

An MCP server that wraps the public [openFDA Device APIs](https://open.fda.gov/apis/device/) into 5 tools for medical device regulatory due diligence. No API key needed. No env vars.

Claude interprets user questions in natural language, picks the right tool(s), and returns FDA data with source links for verification.

## Files

```
~/Documents/Projects/06-mcp-servers/fda-devices/
├── index.ts          # The MCP server — single file, ~450 lines
├── SPEC.md           # Full spec with field paths, URL patterns, design decisions
├── package.json      # deps: @modelcontextprotocol/sdk, zod
├── tsconfig.json
├── bun.lock
└── node_modules/
```

## The 5 Tools

| Tool | Purpose | Primary Input |
|------|---------|--------------|
| `classify_device` | Find product code, device class, regulation number | `query` (device name) or `product_code` |
| `search_510k` | Find 510(k) clearances / predicate devices | `product_code`, `k_number`, `applicant` |
| `search_pma` | Find PMA approvals (Class III) | `product_code`, `pma_number`, `applicant` |
| `search_recalls` | Find device recalls | `product_code`, `recalling_firm` |
| `search_adverse_events` | Search MAUDE reports | `product_code`, `brand_name`, `manufacturer` |

## How to Activate

Registered via CLI (this is the correct method — `~/.claude/settings.json` mcpServers is NOT read by Claude Code CLI):

```bash
claude mcp add fda-devices bun run /Users/prahlaad/Documents/Projects/06-mcp-servers/fda-devices/index.ts --scope user
```

This writes to `~/.claude.json`. Then restart Claude Code.

## What Was Tested (all passing)

12 end-to-end tests against the live openFDA API on 2026-02-19:

1. **classify_device multi-term AND** — `"pulse oximeter"` → 2 results (OLK, MMA), no pacemaker noise
2. **classify_device broadening** — `"blood pressure"` → 14 results including DXN
3. **classify_device direct lookup** — `product_code: "DXN"` → 1 exact result
4. **search_510k by product code + date range** — DXN in 2024 → 17 results, sorted desc
5. **search_510k direct K-number** — K032161 → PHEM-ALERT, Femtek, 77 days to decision (matches Innolitics screenshot)
6. **search_510k by applicant** — `"Boston Scientific"` → 849 results, quoted search works across name variants
7. **search_pma by advisory committee** — CV panel → 28,245 results, sort works
8. **search_recalls by product code** — DXN → 36 recalls, sorted, cfres_id present for source links
9. **search_recalls by firm** — `"Medtronic"` → 1,867 recalls
10. **search_adverse_events + event type** — DXN + Death → 15 reports, correct nested field path
11. **search_adverse_events + YYYYMMDD date range** — DXN in 2025 → 245 reports
12. **Input validation** — K-number passed as product_code → caught with helpful error

## Activation Log

1. **2026-02-19 (initial):** Config added manually to `~/.claude/settings.json` under `mcpServers`. Server started and passed MCP handshake test via stdin.
2. **2026-02-19 (fix):** Tools didn't appear in Claude Code. Root cause: **Claude Code CLI reads MCP server configs from `~/.claude.json`, not `~/.claude/settings.json`**. The `mcpServers` key in `settings.json` is ignored by the CLI. Registered correctly via `claude mcp add ... --scope user`. Confirmed `claude mcp list` shows `fda-devices: ✓ Connected`. Removed stale entry from `settings.json`.
3. **Next:** Restart Claude Code. After restart, the 5 tools should appear in the deferred tools list and be callable via `ToolSearch`.

## What Still Needs Testing

- [x] **Activate as MCP in Claude Code** — registered via `claude mcp add` on 2026-02-19. `claude mcp list` shows connected.
- [x] **Verify MCP handshake** — server responds correctly to `initialize` via stdin. Returns protocol version and tool capabilities.
- [ ] **Restart Claude Code and verify tools appear** — after restart, run `ToolSearch` for "fda" and confirm all 5 tools are in the deferred list
- [ ] **Test each tool individually via MCP** — call each of the 5 tools through Claude Code (not just stdin) to verify end-to-end
- [ ] **Test with natural language queries** — e.g., "What class is a pulse oximeter?", "Find recent 510(k)s for blood pressure monitors"
- [ ] **Test multi-tool chaining** — "I'm building a wearable ECG, what's my regulatory pathway?" (should chain classify_device → search_510k)
- [ ] **Test PMA tool live** — schema validated but not live-tested via MCP yet
- [ ] **Test edge cases** — empty product codes, very long queries, special characters in device names
- [ ] **Test sort fallback** — if sort fails on an endpoint, does it degrade gracefully?
- [ ] **Verify source links in browser** — click AccessData URLs to confirm they resolve (were confirmed via web search, not browser click)

## Key Design Decisions (read SPEC.md for full details)

### Search Strategy (classify_device)
- FDA names are inverted: "Oximeter, Pulse" not "Pulse Oximeter"
- Uses unquoted term-by-term AND search: `device_name:pulse+AND+device_name:oximeter`
- Auto-broadens by dropping last word if no results (3+ word queries)
- Falls back to searching `definition` field if `device_name` returns nothing

### URL Construction
- Built manually, NOT via URLSearchParams — URLSearchParams encodes `+` as `%2B` which breaks openFDA's `+AND+` syntax. This was a bug caught during testing.

### Date Formats (inconsistent across endpoints!)
| Endpoint | Format | Date Range Query |
|----------|--------|-----------------|
| 510(k), PMA, Recalls | `YYYY-MM-DD` | `[YYYY-MM-DD+TO+YYYY-MM-DD]` |
| Adverse Events | `YYYYMMDD` | `[YYYYMMDD+TO+YYYYMMDD]` |

Tool accepts `YYYY-MM-DD` always, converts internally.

### Recall Severity Gap
- Recall endpoint has `product_code` search but NO severity classification (Class I/II/III)
- Enforcement endpoint has severity but `openfda` object is frequently empty — can't search by product code
- Decision: Use recall endpoint, include FDA source link where severity is visible on their page

### Adverse Events
- Only curated fields returned (not 80+ raw fields)
- Mandatory caveat prepended to every response about unverified/self-reported nature
- Product code searched via `device.device_report_product_code` (NOT `device.product_code` — that doesn't exist)

### Every Response Includes
- The exact API query URL (reproducible, citable)
- `meta.last_updated` from openFDA
- FDA disclaimer
- FDA AccessData source link per record

## Source Links (all verified)

| Type | URL Pattern | API Field |
|------|------------|-----------|
| 510(k) | `accessdata.fda.gov/.../cfpmn/pmn.cfm?ID={k_number}` | `k_number` |
| PMA | `accessdata.fda.gov/.../cfpma/pma.cfm?id={pma_number}` | `pma_number` |
| Classification | `accessdata.fda.gov/.../cfpcd/classification.cfm?ID={product_code}` | `product_code` |
| Recall | `accessdata.fda.gov/.../cfres/res.cfm?id={cfres_id}` | `cfres_id` |
| MAUDE | `accessdata.fda.gov/.../cfmaude/detail.cfm?mdrfoi__id={mdr_report_key}` | `mdr_report_key` |
| eCFR | `ecfr.gov/current/title-21/.../section-{regulation_number}` | `regulation_number` |

## What This Replaces

The [Innolitics FDA Browser](https://fda.innolitics.com/) — a web app that organizes FDA device data into a browsable tree (Panel → CFR Subpart → Product Code → Submissions). This MCP provides the same data plus recalls and adverse events, queryable through natural language via Claude.

**What the MCP can't do that Innolitics can:** Show an "Analyzed PDF" feature that extracts predicate device info from 510(k) summary PDFs. Predicate data is not in any API — only in unstructured PDFs.

## Future Enhancements (v2)

- PDF fetching + Claude analysis for predicate extraction
- Company overview tool (cross-endpoint)
- Compare 510(k)s side-by-side
- Count/aggregation tool (with proper caveats)
- De Novo tracking
- API key support for higher rate limits
