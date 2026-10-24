---
name: comparison-analysis
description: >
  Sub-Skill for competitive & product research. Owns the end-to-end workflow
  from scope definition through multi-framework analysis to final deliverable.
  Covers feature matrices, financial benchmarking, SWOT, Porter's Five Forces,
  competitive positioning, strategy projection, and differentiation playbooks.
  Inherits source-hierarchy, citation, and cross-validation rules from
  research-guide; adds domain-specific frameworks, templates, and quality gates.
---

# Competitive & Product Analysis

## 0. Relationship to Parent

This Skill inherits **all** constraints from `research-guide`:

- Source hierarchy (§3.1), hard constraints (§3.2), strategy selection (§3.3), search paradigm (§3.4), and cross-validation (§3.5).
- Citation format: `[cite:N]` inline (numbered from 1 per response); append a "Sources" section where each entry starts with `[cite:N]` followed by title and URL. When writing to file, use HTML anchors per §5 File output rule.
- Conflict resolution: present both sides; never pick arbitrarily.

Anything defined below **extends** the parent; it never overrides.

---

## 1. Step 1 — Purpose & Depth Calibration

### 1.1 Purpose → Template Mapping

| Purpose | Focus Dimensions | Output Emphasis | Depth |
|---------|-----------------|-----------------|-------|
| **Product Design** | Feature matrix + UX | Feature gap list + differentiation playbook | Moderate |
| **Fundraising Deck** | Market landscape + defensibility | Positioning map + moat analysis | Concise |
| **Strategic Planning** | Full-spectrum | SWOT + Five Forces + pricing + roadmap projection | Deep |
| **Annual Review** | Market-share shifts + trends | YoY delta analysis + trend calls | Moderate |

### 1.2 Industry-Defining Metrics

Before data collection, identify the **3–5 metrics that best differentiate players** in the relevant industry. Use the table below as a starting point; adapt to context.

| Industry | Key Metrics |
|----------|-------------|
| SaaS | ARR, NRR, CAC payback, LTV/CAC, Rule of 40, RPO |
| Payments / Fintech | GPV, take rate, attach rate, transaction margin |
| Marketplaces | GMV, take rate, buyer/seller ratio, repeat purchase rate |
| Retail | Same-store sales, inventory turns, sales/sqft, e-commerce mix |
| Industrials | Backlog, book-to-bill, capacity utilization, price vs. volume split |
| Healthcare | Scripts, patient volumes, pipeline milestones, R&D as % of revenue |
| Semiconductors | Revenue by end-market, ASP trends, design wins, fab utilization |
| Consumer Software | DAU/MAU, retention (D1/D7/D30), ARPU, engagement time |

> If no clear industry match, derive bespoke metrics from competitor earnings calls or product pages and state the rationale.

---

## 2. Step 2 — Information Gathering

Follows `research-guide` §3 in full. This section adds **domain-specific checklists and credibility grading**.

### 2.1 Credibility Grading

| Grade | Source Type | Annotation |
|-------|-----------|------------|
| **High** | Official website, pricing page, earnings report, regulatory filing | Cite directly |
| **Medium** | Tier-1 media, analyst reports, user reviews (G2 / Capterra / app stores) | Tag source name |
| **Low** | Rumors, outdated data (>12 months), unverified self-media | Tag `[unverified]` |

### 2.2 Collection Checklist

| Dimension | Items | Typical Sources |
|-----------|-------|----------------|
| Fundamentals | Founded date, funding stage, team size, user base | Official site, Crunchbase, PitchBook |
| Product | Core feature list, recent releases, public roadmap | Official site, changelog, blog |
| Pricing | Plan tiers, price points, free-tier limits, billing model | Pricing page |
| Reputation | Top praise points, top complaints, NPS / ratings | G2, app stores, forums |
| Strategy | Target segment, acquisition channels, partnerships, positioning statement | Press, social media, job postings |
| Financials (if public) | Revenue, margins, segment breakdown, capital allocation | SEC filings, earnings transcripts |

### 2.3 Timeliness Annotation

Every piece of competitor data must carry a temporal tag, e.g., `(as of 2026-Q1 public info)`. Remind the user to verify the latest situation when data age > 6 months.

### 2.4 Parallel vs. Sequential

Apply `research-guide` §3.3 strategy selection:

- **Multiple independent competitors** → parallel fan-out, one search thread per competitor.
- **Deep-dive on a single rival** → sequential drill-down.
- **Fast-moving market** → recency-first; start with P1–P2, trace back to P0.

---

## 3. Step 3 — Evaluation & Analytical Frameworks

### 3.1 Porter's Five Forces

| Force | Analysis Dimension | Assessment Focus |
|-------|--------------------|------------------|
| **Supplier Power** | Upstream dependency | Key tech / talent / resource concentration; switching cost |
| **Buyer Power** | Downstream customer leverage | Customer concentration; switching cost; price sensitivity |
| **Threat of New Entrants** | Entry barriers | Tech barriers, capital requirements, brand moat, network effects, regulatory hurdles |
| **Threat of Substitutes** | Alternative solutions | Current substitutes; substitute price–performance ratio |
| **Industry Rivalry** | Current-player dynamics | Number of competitors, market concentration, differentiation degree, exit barriers |

**Output per force**: Strong / Moderate / Weak + one-sentence rationale with citation.

**Aggregate**: Overall industry attractiveness = High / Medium / Low.

### 3.2 Competitive Moat Assessment

| Moat Type | Criteria |
|-----------|----------|
| Network Effects | Strength of user / supplier flywheel |
| Switching Costs | Integration depth, data lock-in, workflow dependency |
| Scale Economies | Unit cost advantage at volume |
| Intangible Assets | Brand equity, proprietary data, licenses, patents |

Rate each as **Strong / Moderate / Weak** with supporting evidence. Cite source for every claim.

---

## 4. Step 4 — Multi-Dimensional Comparison

### 4.1 Feature Comparison Matrix (core deliverable)

| Feature Module | Sub-feature | Ours | Comp A | Comp B | Comp C |
|---------------|-------------|------|--------|--------|--------|
| {Module 1} | {Sub-feature 1} | ✅ Full | ✅ Full | ⚠️ Basic | ❌ None |
| | {Sub-feature 2} | ⚠️ Basic | ✅ Full | ✅ Full | 🔜 Planned |

Legend: ✅ Full — ⚠️ Basic (exists, incomplete) — ❌ None — 🔜 Planned

### 4.2 SWOT Analysis (per competitor or per our-product-vs-field)

| | Positive | Negative |
|---|----------|----------|
| **Internal** | **Strengths** | **Weaknesses** |
| **External** | **Opportunities** | **Threats** |

- 2–3 items per quadrant; each must cite a verifiable fact.
- No empty phrases ("strong team", "advanced tech").

**SWOT Cross-Strategy Matrix** (when purpose = Strategic Planning):

| Strategy | Meaning | Action Direction |
|----------|---------|-----------------|
| **SO** | Leverage strengths to capture opportunities | Exploit market windows with core advantages |
| **WO** | Address weaknesses to capture opportunities | Close gaps that block new growth vectors |
| **ST** | Leverage strengths to counter threats | Use moats to defend against competitive pressure |
| **WT** | Address weaknesses to mitigate threats | Highest-urgency defensive moves |

### 4.3 Financial Benchmarking (when dimension includes Financial Performance)

| Metric | Ours | Comp A | Comp B | Comp C | Sector Median |
|--------|------|--------|--------|--------|---------------|
| Revenue (LTM) | | | | | |
| Revenue growth (3-yr CAGR) | | | | | |
| Gross margin | | | | | |
| EBITDA margin | | | | | |
| FCF margin | | | | | |

**Valuation Comparison** (public companies only):

| Metric | Ours | Comp A | Comp B | Comp C |
|--------|------|--------|--------|--------|
| P/E (NTM) | | | | |
| EV/EBITDA (NTM) | | | | |
| EV/Revenue (NTM) | | | | |
| Premium / discount to median | | | | |

### 4.4 Pricing Strategy Comparison (when dimension includes Pricing)

| Item | Ours | Comp A | Comp B | Comp C |
|------|------|--------|--------|--------|
| Free-tier capability | | | | |
| Starter monthly price | | | | |
| Enterprise monthly price | | | | |
| Billing model | per-seat / usage / feature | | | |
| Pricing strategy type | Penetration / Skimming / Freemium | | | |

**Pricing strategy classification**:
- **Penetration**: low price to capture share (rich free tier signals this).
- **Skimming**: premium price for high-end positioning (heavy feature gating).
- **Freemium**: core free, advanced paid (look at free-vs-paid feature gap).

### 4.5 UX & Technical Architecture Comparison (optional dimensions)

| Dimension | Method | Scoring |
|-----------|--------|---------|
| **UX** | Core-flow step count, learning curve, task-completion efficiency | Compare clicks and time for key workflows |
| **Tech Architecture** | Architecture pattern, tech stack, performance indicators, openness | API breadth, integration capability, extensibility |

---

## 5. Step 5 — Competitive Positioning & Strategy Projection

### 5.1 Positioning Map

Select the **two dimensions that most differentiate** the competitors (e.g., "Feature depth vs. Ease of use" or "Price vs. Feature breadth"). Place all products into a 2×2 quadrant:

| Quadrant | Characteristics | Representative Products |
|----------|----------------|----------------------|
| High capability + High price | Enterprise-grade all-in-one | {list} |
| High capability + Low price | Value play | {list} |
| Low capability + High price | Niche / vertical specialist | {list} |
| Low capability + Low price | Entry-level | {list} |

### 5.2 Market Landscape Classification

| Landscape Type | Signature | Strategy Implication |
|---------------|-----------|---------------------|
| **One dominant + many small** | One player > 50% share | Differentiate in niches; avoid head-on |
| **Duopoly** | Top 2 combined > 70% | Align with an ecosystem or position as the third alternative |
| **Fragmented** | Top 5 each < 20% | Race to own a micro-segment first |
| **Nascent** | No clear leader | Invest in market education; build brand early |

### 5.3 Strategy Projection

Infer each competitor's likely next moves from recent signals:

1. **Signal Collection**: product updates, funding events, hiring patterns, partnership announcements in the past 3–6 months.
2. **Pattern Recognition**:
   - Cluster of releases in one area → likely doubling down.
   - Hiring surge in a function → may be building a new product line.
   - Price cuts or free-tier expansion → market-share grab.
3. **Projection Table**:

| Competitor | Recent Key Moves | Inferred Strategic Intent | Impact on Us | Confidence | Suggested Response |
|-----------|-----------------|--------------------------|-------------|------------|-------------------|
| Comp A | {description} | {inference} | {assessment} | High / Med / Low | {action} |

- Clearly separate **confirmed facts** from **inferred intent**; the latter must carry a confidence tag.
- Provide short-term (1–3 months) and medium-term (3–12 months) projections when data supports it.

### 5.4 Scenario Analysis (when investment context is provided)

| Scenario | Probability | Revenue | EPS | Key Driver |
|----------|-------------|---------|-----|------------|
| Bull | 25–30% | $X.XB | $X.XX | ... |
| Base | 45–50% | $X.XB | $X.XX | ... |
| Bear | 20–30% | $X.XB | $X.XX | ... |

Probabilities must sum to ~100%. Every driver must be cited.

---

## 6. Step 6 — Differentiation Playbook

### 6.1 Three-Tier Differentiation Strategy

| Tier | Description | Action Items |
|------|-------------|-------------|
| **Catch-up** | Features all competitors have but we lack | List features + priority + estimated effort |
| **Differentiate** | Features where we lead or are unique | List advantages to reinforce + messaging hooks |
| **Innovate** | Blue-ocean opportunities no competitor addresses | List exploratory ideas + validation approach |

### 6.2 Monitoring Cadence (recommendation, not mandatory output)

| Frequency | Scope | Trigger Action |
|-----------|-------|---------------|
| Weekly | Competitor release logs, social media | Log major updates to tracking sheet |
| Monthly | Pricing changes, new features, press | Refresh feature comparison matrix |
| Quarterly | Full competitive report + strategy projection refresh | Distribute competitive brief to team |
| Event-driven | Funding, M&A, major launch, leadership change | Immediate impact assessment + response memo |

---

## 7. Report Output Specification

### 7.1 Default Structure

1. **Executive Summary** — one-page conclusion: landscape type, our position, top 3 action items.
2. **Scope & Methodology** — competitors covered, dimensions analyzed, data cut-off date, credibility grading summary.
3. **Industry Context** — Porter's Five Forces + moat assessment.
4. **Multi-Dimensional Comparison** — feature matrix, SWOT, financial benchmarks, pricing comparison (as applicable per dimensions).
5. **Competitive Positioning** — positioning map + landscape classification.
6. **Strategy Projection** — per-competitor projection table.
7. **Differentiation Playbook** — three-tier strategy + monitoring cadence.
8. **Appendix** — raw data tables, methodology notes.

> Sections 3–6 scale based on analysis purpose (§1.1). For "Fundraising Deck" purpose, compress into a single positioning + moat slide. For "Strategic Planning", expand all.

### 7.2 Format

- Default: Markdown. Adapt if user requests `.pptx` or `.docx`.
- All tables use consistent column-width alignment.
- All headings must be descriptive and neutral — never rhetorical, persuasive, or argumentative.
- Charts follow `research-guide` §4 (Visual Generation Guide).

---

## 8. Quality Gate — Exit Criteria

The report is NOT ready for delivery until every item below is verified:

- [ ] Every quantitative value carries a `[cite:X]` tag.
- [ ] All competitors are evaluated on the **same dimensions with the same scales** — no apples-to-oranges.
- [ ] SWOT items are fact-backed; no vague praise or criticism.
- [ ] Data timeliness annotated on every competitor section.
- [ ] Credibility grades assigned per §2.1; `[unverified]` tags present where needed.
- [ ] Strategy-projection rows clearly separate facts from inferences; confidence tags present.
- [ ] Scenario probabilities sum to ~100% (if applicable).
- [ ] Industry-specific KPIs (§1.2) are included in comparison tables.
- [ ] Missing data labeled `N/A` or `—`; never fabricated.
- [ ] Porter's Five Forces ratings each have supporting evidence.
- [ ] Differentiation playbook priorities are justified.

---

## 9. Red-Line Rules

1. **No fabricated data.** Unverified competitor information must be tagged `[unverified]`. Synthetic or simulated numbers are strictly prohibited.
2. **No subjective disparagement.** Competitor assessments must be objective; no pejorative language.
3. **Timeliness labeling mandatory.** Every data point must carry a date or period tag. Prompt the user to re-verify when data age > 6 months.
4. **Confidence tagging on projections.** Every inferred strategic intent must carry a confidence level (High / Medium / Low).
5. **Consistent measurement.** Same metric definition, same fiscal period, same currency across all compared entities.
