# Report Contract

The structure of the delivered report, referenced by `SKILL.md`. Choose the lightest
structure that serves the reader; do not force sections that add no value.

## Report structure

1. **Title block**: the question as researched, date, scope, and important
   assumptions you made when clarifying would not have changed the work.
2. **Executive answer**: a direct answer to the question in the first lines —
   the reader should be able to stop here and still have the conclusion.
3. **Analysis**: organized around the user's real sub-questions, not around your
   search history. Prefer prose with citations; use tables only for short
   enumerable comparisons.
4. **Contradictions and uncertainty**: material disagreements between sources with
   both sides cited; which you find better supported and why; claims that remain
   uncertain or inaccessible.
5. **Implications or recommendations**: only when requested or clearly useful to
   the stated audience decision.
6. **Search account**: the searches performed, why you stopped (the diminishing-
   return test result), and known gaps a follow-up pass would target.

## Claim-to-source ledger

Every material sourced claim in the report must be traceable to a ledger entry:

| claim (short form) | source title | publisher/author | date | URL | status |
|---|---|---|---|---|---|
| … | … | … | … | … | fact / inference / uncertain / inaccessible |

Keep the ledger in the report's final section when the report is a file; when the
report is delivered in chat, keep the ledger compact (one line per consequential
claim) but keep it. If a worker performed searches, preserve its search log in the
account — do not reconstruct it from memory.

## Citation rules

- Cite at the claim, not at the paragraph: the reader should never wonder which
  sentence a source supports.
- Include title, publisher or author, date when available, and URL. Mark undated
  sources as undated.
- Quote sparingly and within source-use limits; prefer precise paraphrase.
- Never fabricate or guess a URL; a source you cannot link gets title + publisher
  + date and an explicit "URL not captured" note.
- Do not present your own inference as a sourced fact; label it as inference.

## Honesty rules

- Do not describe any step as done that was not actually done — including
  "verified", "confirmed by testing", or "checked against the primary source".
- If access was incomplete (paywalls, auth-only sources, rate limits), say which
  sources were unreachable and which claims that weakens.
- Confidence statements must match the ledger: a claim resting on one weak source
  is not "well established".
