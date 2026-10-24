---
name: research-report
description: >
  Default sub-Skill for producing any research deliverable as a structured report.
  Route here whenever the research task results in a standalone document — market
  research, technology evaluation, policy analysis, industry deep-dive, literature
  review, feasibility study, or any general research output that does not
  specifically require competitive/comparison analysis. This is the preferred
  fallback: if no other sub-Skill (e.g. comparison-analysis) explicitly matches,
  route to research-report. Inherits source-hierarchy, citation, and
  cross-validation rules from research-guide; adds report structure, writing
  principles, length calibration, domain templates, and quality gates.
---

# Research Report

## 0. Relationship to Parent

This Skill inherits **all** constraints from `research-guide`:

- Source hierarchy (§3.1), hard constraints (§3.2), strategy selection (§3.3), search paradigm (§3.4), and cross-validation (§3.5).
- Citation format: `[cite:N]` inline (numbered from 1 per response); append a "Sources" section where each entry starts with `[cite:N]` followed by title and URL. When writing to file, use HTML anchors per §5 File output rule.
- Conflict resolution: present both sides; never pick arbitrarily.
- Visual generation: follows `research-guide` §4.

Anything defined below **extends** the parent; it never overrides.

---

## 1. Content Separation

The report is a **standalone reference document** — comprehensible without chat context.

- Direct answers to the user's question go in the **chat response**, NOT in the report.
- Think of the chat response as the executive summary and the report as the full analysis.
- The report contains ONLY research findings, analysis, and evidence.

---

## 2. Report Format

### 2.1 Markdown Specification

Reports use **standard GitHub-Flavored Markdown (GFM)** supporting:

- Standard Markdown: headings, paragraphs, lists, emphasis, links, code blocks.
- Markdown tables for comparisons and structured data.
- Inline `[cite:N]` citations matching search result indices.
- LaTeX math expressions: `\( \)` for inline, `\[ \]` for block. Never use `$` or `$$`.
- No Mathpix Markdown — plain GFM only.

> Treat prices, percentages, dates, and similar numeric text as regular text, not LaTeX.

### 2.2 Heading Hierarchy

- `#` (H1) — report title only.
- `##` (H2) — major sections.
- `###` (H3) — subsections within major sections.
- All headings must be descriptive and neutral — never rhetorical, persuasive, or argumentative.
- Do not skip heading levels (e.g., H1 directly to H3).

### 2.3 Tables

- Use tables when comparing 2+ entities across shared attributes.
- Use tables for structured data with clear rows and columns.
- Prefer tables over long prose when readers need to compare values side-by-side.
- Keep tables focused — if a table exceeds 6–7 columns, consider splitting.
- Include citations in table cells where data comes from sources.

---

## 3. Report Structure

The model determines appropriate structure based on topic, purpose, and complexity.

### 3.1 Common Components

| Component | Purpose |
|-----------|---------|
| **Title** (H1) | Clear, descriptive report title |
| **Executive Summary / Overview** | Brief synthesis of key findings |
| **Body sections** (H2/H3) | Organized by topic, theme, or argument |
| **Analysis / Discussion** | Interpretation, trade-offs, implications |
| **Conclusion** | Summary of findings and actionable takeaways |

### 3.2 Domain-Specific Structures

Follow conventional structures for the domain when applicable:

| Domain | Structure |
|--------|-----------|
| **Academic** | Introduction → Literature Review → Methodology → Analysis → Discussion → Conclusion |
| **Investment / Market** | Executive Summary → Industry Overview → Competitive Landscape → Financial Analysis → Risks → Conclusion |
| **Technical** | Overview → Architecture / Methodology → Analysis / Results → Discussion |
| **Policy / Legal** | Summary → Context → Stakeholder Analysis → Evidence Review → Implications → Recommendations |

Adapt structure to what the query actually requires — do not force a template onto a simple query.

---

## 4. Citation System

### 4.1 When to Cite

**ALWAYS include citations when:**

- Topic was researched (tool calls made).
- Report contains factual claims from sources.
- Making claims about data, statistics, research findings.
- Describing events, discoveries, or developments.

**Optional / no citations when:**

- Personal writing or opinion pieces.
- Creative writing.
- Templates or blank forms.
- User explicitly states "no citations needed".

### 4.2 Citation Format

Use `[cite:N]` inline, where N is the numeric index from tool responses.

**Inline citations:**

```markdown
Recent research shows significant AI advances. Multiple studies confirm this trend.[cite:2][cite:3][cite:4]

Climate change impacts are accelerating globally. Temperature increases exceed predictions.[cite:5][cite:6]
```

**In tables:**

```markdown
| Method | Accuracy | Source |
|--------|----------|--------|
| Method A | 95.2% | [cite:8] |
| Method B | 93.8% | [cite:9] |
```

### 4.3 Citation Rules

- Place `[cite:N]` immediately after the claim or fact.
- Multiple sources: `[cite:2][cite:5]` — no spaces, no ranges.
- Aim for 1–3 citations per substantive claim.
- Distribute citations throughout — maintain consistent density from beginning to end.
- For longer reports with multiple sources, include a "Sources" section at the end listing all referenced URLs or source identifiers.
- Only cite actual sources from search results — never fabricate citations.

### 4.4 Citing Assets

Assets (code files, PDFs) with a `type` of `code_file` or `pdf` are cited inline by their `id` number.

- Cite assets using `[cite:N]` on a **new line**, immediately AFTER the relevant header or paragraph. Never inline within a sentence.
- Never cite the same asset more than once.
- Never cite assets not received from tools.
- NEVER cite an asset by filename — always cite by `id` number.

### 4.5 Citing User-Attached Images

When referencing user-attached images, use `[image:N]` where N is the image index from attachment metadata.

---

## 5. Writing Principles

### 5.1 Structure

- Lead with the direct answer, then provide supporting context.
- Use paragraphs of 3–8 sentences for most content.
- Never use first-person pronouns ("I", "my", "we", "our") or self-referential phrases.

### 5.2 Lists

- Use bullet points when information is naturally list-like: options, features, pros/cons, steps, recommendations, or any set of 3+ parallel items.
- Lists improve scannability — use them when readers may want to skim or reference specific points.
- For extended analysis or argumentation where logical flow matters, prose is clearer.

### 5.3 Headings

- Use headings to signal major topic shifts.
- Not every section needs a heading — use judgment based on length and complexity.
- Simple answers may need no headings at all.

### 5.4 Brevity

- Match length to query complexity — simple questions get short answers.
- Avoid restating information in different words.
- Omit introductory preamble when the answer can lead directly.

### 5.5 Logical Flow

- Introduce concepts before building on them.
- Make transitions explicit ("Building on this…", "This raises the question of…", "In contrast…").
- Ensure conclusions synthesize the analysis, drawing key threads into actionable insights.

### 5.6 Analysis

- Lead with conclusions, then support with evidence.
- Analyze rather than summarize: explain causation, trade-offs, and what makes information actionable.
- When sources conflict, state the disagreement, evaluate source quality, and justify the conclusion.
- Apply analytical frameworks when relevant (e.g., Porter's Five Forces, SWOT).
- Anticipate the "so what?" — help users understand why information matters and how to apply it.

### 5.7 Relevance

- Keep the user's core question as the north star throughout.
- When exploring related topics, connect them back to the main question.
- Anticipate follow-up questions and address them proactively.

---

## 6. Vocabulary Calibration

Before writing, assess the user's knowledge level from their query vocabulary and sophistication:

| Level | Approach |
|-------|----------|
| **Expert** | Use precise domain language without explanation |
| **Intermediate** | Use technical terms with brief inline context |
| **General** | Define jargon on first use |

---

## 7. Length Calibration

The research process is always comprehensive. Output length adapts to user intent:

| Request Type | Length | Notes |
|-------------|--------|-------|
| **Concise / summary** ("Brief overview…", "Summarize…") | 5–10 paragraphs | Distill findings into the most essential points |
| **Fact-seeking** ("What is X?", "When did Y happen?") | 5–10 paragraphs | Direct answer with rich context |
| **Comparison / ranking** ("Compare the top 5…", "Best options for…") | 20–40+ paragraphs | Structured analysis; prefer tables over lengthy prose |
| **Open-ended research** ("Analyze…", "Explain the history and implications of…") | 20–40+ paragraphs | Full analytical depth |
| **Explicit depth** ("Comprehensive report…", "Deep dive…") | No upper limit | Length determined by topic scope |
| **All other queries** | Default to comprehensive | When in doubt, provide more depth rather than less |

---

## 8. Source Depth

Prioritize primary and authoritative sources. Preference order: official documentation, peer-reviewed research, established news outlets, government sources, recognized industry experts — over blogs, forums, or unverified sources.

| Query Complexity | Requirement |
|-----------------|-------------|
| **Simple factual** | Search until consistent, authoritative answers from multiple sources — do not stop at first result |
| **Moderate research** | Substantive analysis with multiple perspectives; 3+ independent sources per key claim |
| **Complex research** (reports, competitive analysis, literature reviews) | Cover all major viewpoints and sub-topics; support recommendations with evidence; identify limitations; trace key claims to original sources |

- Cross-validate important claims across multiple sources.
- When conflicting information appears, investigate further rather than arbitrarily choosing one source.
- Identify knowledge gaps explicitly — state what information could not be found or verified.

---

## 9. Quality Gate — Exit Criteria

The report is NOT ready for delivery until every item below is verified:

- [ ] Valid GFM syntax, appropriate heading hierarchy.
- [ ] Markdown tables for comparisons and structured data.
- [ ] No MMD syntax — plain GFM only (LaTeX math allowed per §2.1).
- [ ] **Citation check (if researched):**
  - [ ] Inline `[cite:N]` citations present for factual claims.
  - [ ] For longer reports, a "Sources" section at the end lists all referenced URLs.
  - [ ] Citations correspond to actual search result indices.
  - [ ] 1–3 citations per substantive claim.
  - [ ] Consistent citation density throughout.
  - [ ] Sources from actual search results (not invented).
- [ ] No first-person pronouns.
- [ ] Report is standalone — comprehensible without chat context.
- [ ] Report structure appropriate for topic and purpose.
- [ ] Appropriate length — matches query complexity per §7.
- [ ] No TODOs or placeholders — all sections fully written.
- [ ] Real data only — never fabricate citations or data.
- [ ] Direct answer in chat, detailed analysis in report.

---

## 10. Red-Line Rules

1. **No fabricated data.** Unverified information must be tagged `[unverified]`. Synthetic or simulated numbers are strictly prohibited.
2. **No first-person.** Never use "I", "my", "we", "our" or self-referential phrases.
3. **Standalone document.** The report must be comprehensible without the chat context.
4. **Citation integrity.** Only cite sources actually retrieved via tools. Never invent citation indices.
5. **Consistent measurement.** Same metric definitions, same time periods, same units across all compared entities.
