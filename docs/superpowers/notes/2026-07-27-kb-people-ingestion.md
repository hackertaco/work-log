# KB `raw/people/` ingestion — spike finding (2026-07-27)

**Verdict: (b) a KB-side change is required.** `raw/people/*.md` does NOT
become a 사람(Person) node with zero KB changes.

Evidence (`driving-teacher-knowledge-base/scripts/graph_v2_build.py`):

- `collect_documents`/`collect_inventory` (lines 851–859, 832–848) do
  `raw_root.rglob("*")`, so a new `raw/people/` folder IS walked recursively
  and normalized into `documents.jsonl` automatically — no change needed for
  that part.
- BUT `build_typed_graph` (line 680) skips any document whose `source_group`
  (= its top-level folder under `raw/`, per `source_group_for`, line 243)
  is not in `TARGET_SOURCE_GROUPS` (lines 35–53). `"people"` is **not** in
  that set, so `raw/people/*.md` docs are excluded before any node logic
  runs — zero nodes/edges emitted as-is.
- Even inside `TARGET_SOURCE_GROUPS`, Person nodes come only from
  `extract_people()` (lines 629–647), which scrapes *mentions* of people in
  other docs' `담당자`/`작성`/`참석자` fields or `"OO 님"`/`"@OO"` patterns —
  there is no path that treats a whole markdown file as *being about* one
  person via folder location or frontmatter identity.
- `graph_v2_build_people.py` looks related but is a separate pipeline
  (docs/data/people.json, "내 브리핑" page) keyed to a hand-maintained
  `USERS` dict of Notion user-IDs and requires notion-style `captured_at`
  frontmatter (lines 22–33, 124–126). It also is **not** invoked by
  `refresh-kb.yml` — only by `sync-notion.yml` — so it's irrelevant to the
  push-to-main path anyway.

Confirmed push trigger (`refresh-kb.yml` lines 10–18, 22): fires on push to
`main` with `paths: raw/**, scripts/**, notion_sync.py, docs/prd-html/index.html,
.github/workflows/**`; `concurrency.group: kb-pipeline-${{ github.ref }}`.
It runs `graph_v2_build.py` (line 45) but not `graph_v2_build_people.py`.

**Out-of-scope KB follow-up (separate task):** add `"people"` to
`TARGET_SOURCE_GROUPS` and add a node-creation path in `build_typed_graph`
that identifies a Person node from the `raw/people/{id}.md` file itself
(e.g. folder + filename/frontmatter), not just from regex-mined mentions.
This plan still delivers the committed markdown to `raw/people/`; KB node
rendering needs that follow-up.
