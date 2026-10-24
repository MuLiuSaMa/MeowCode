---
name: prd-authoring
description: "Turns incomplete product ideas into reviewable PRDs. Invoke for PRD creation, completion, rewriting, feature specs, product requirements, or prototype-centered interactive PRDs."
---

## Step-by-step execution and dependencies

1. Follow this Skill's workflow in order. Before a step uses a library, command-line tool, runtime, or font, check only the dependencies required by that step; do not assume they are installed.
2. Reuse dependencies that are available. If one is missing, install only that dependency using the current OS and an available package manager, then verify it and retry the original step. Do not install the entire dependency list in advance.
3. Use the active Python environment (`python -m pip install <package>`, or the matching `python3`); create a task-local virtual environment if needed. Install Node.js libraries in the task project (`npm install <package>`) so the script can resolve them. For system tools and fonts, use the available OS package manager (for example, Homebrew on macOS, apt on Debian/Ubuntu, or winget on Windows).
4. Follow the host's permission flow when installation needs approval. If the package manager or required permission is unavailable, or installation/download fails, report the missing dependency and affected step; do not retry indefinitely or claim the step passed. Continue independent steps when possible.
5. Keep the original workflow and quality checks. Check fonts only when rendering requires them. Steps using only text, built-in tools, or self-contained HTML require no package installation; external tool access or authentication must be handled through the host, not a package manager.

# PRD Authoring

Create product requirements documents that let product, design, and engineering
make the same decisions without inventing missing business rules.

## Use This Skill

Invoke for requests such as:

- write, complete, rewrite, or improve a PRD;
- create a product requirement document or feature specification;
- turn notes, meeting records, research, or an existing draft into a PRD;
- define an MVP, new product, new module, or product iteration;
- document user flows, permissions, states, fields, and exception rules;
- create an interactive PRD, prototype-first PRD, or linked prototype and requirements;
- review a PRD for missing product decisions and internal contradictions.

Do not use this skill for:

- technical architecture, API design, database design, or implementation plans;
- standalone market research, competitor reports, or user research;
- marketing copy, articles, manuals, presentations, or general reports;
- a visual prototype with no requirement document;
- project staffing, delivery scheduling, or operations planning unless the user
  explicitly asks to include them in the PRD.

Use a dedicated research skill before this one when the user needs new evidence
collected. Use a technical-design skill after this one when implementation
architecture is required.

## Operating Principles

1. A PRD defines product behavior and business decisions, not implementation choices.
2. Functional requirements are the core deliverable and should carry most of the detail.
3. Scope follows the smallest complete user journey, not a generic feature inventory.
4. Do not invent research findings, metrics, fees, limits, SLAs, legal conclusions,
   user preferences, or business rules.
5. Mark missing values as `[TBD]` and inferred conditions as `[Assumption, TBD]`.
6. Ask a question only when the answer could materially change permissions, money
   movement, compliance, the core flow, or an irreversible action. Otherwise proceed
   with a marked assumption.
7. Remove ambiguity through concrete decisions. Do not pad sections to meet a word count.
8. Keep one canonical definition for every role, object, status, calculation, and rule.

## Input Assessment

Read all supplied notes and attachments before drafting. Classify important inputs:

| Class | Meaning | Treatment |
|---|---|---|
| Confirmed fact | Explicitly supplied or supported by a named source | May support a requirement directly |
| Product judgment | A decision derived from confirmed context | Explain the reasoning when it changes scope or flow |
| Assumption | A plausible condition needed to continue | Mark `[Assumption, TBD]` |
| Open question | Missing information that can materially change the product | Mark `[TBD]`; ask only when work cannot safely continue |

Internally establish:

- primary user and the outcome they need;
- trigger that starts the journey;
- completion condition that proves the job is done;
- shared business object, when multiple roles are involved;
- P0 journey needed to enter, complete, and recover;
- relevant P1 support and explicitly excluded speculative features;
- consequential actions involving money, ownership, permissions, publishing,
  deletion, approval, or compliance.

## Output Routing

Apply these rules in order and load only the selected reference.

| Route | Load | Signals |
|---|---|---|
| Prototype-centered interactive PRD | `references/interactive-prd.md` | Interactive PRD, prototype-first, persistent prototype, split screen, left prototype/right document, clickable flow linked to requirements |
| Conventional PRD | `references/conventional-prd.md` | Generic PRD, product requirements, feature spec, MVP spec, chapter-based document, embedded demos inside functional sections |

Routing details:

1. Explicit prototype-centered language always selects `interactive-prd.md`.
2. A conventional PRD may still contain embedded interactive demos; that alone does
   not make it prototype-centered.
3. Text-only Markdown, DOCX, or PDF selects `conventional-prd.md` unless the user also
   requests a separate interactive HTML companion.
4. If the request only says PRD or product requirements, select `conventional-prd.md`.
5. Ask about document architecture only when both routes are equally plausible and
   choosing one would materially alter the deliverable.

## Format Contract

- Respect an explicitly requested format.
- Without a format request, produce a self-contained HTML PRD.
- An interactive PRD is a self-contained HTML artifact unless the user explicitly
  asks for a static companion.
- For Markdown, DOCX, or PDF, replace interactions with concise flow, state, or
  layout diagrams where needed.
- Keep the final artifact directly usable. Do not return only an outline when the
  user asked for a completed PRD.

## Workflow

1. Read the full request and all available source material.
2. Separate facts, judgments, assumptions, and open questions.
3. Define the product contract: user, job, trigger, completion, shared object, and trust.
4. Scope the smallest complete P0 journey and relevant recovery paths.
5. Select exactly one PRD route and load its reference.
6. Determine document depth from product scope and risk, not from desired page count.
7. Draft the artifact with functional requirements as the dominant section.
8. Resolve contradictions across roles, fields, statuses, permissions, and calculations.
9. Run the common checks below and the selected reference's mode-specific checks.
10. Revise failures before delivery; do not expose the internal checklist as a document section.

## Common Final Checks

The checks are mandatory for both routes:

| Check | Pass condition |
|---|---|
| Product contract | Primary user, trigger, core job, and completion condition are clear |
| Scope | Every P0 feature supports completion or recovery; speculative features are excluded |
| Traceability | Major decisions derive from supplied evidence, stated judgment, or a marked assumption |
| Requirement depth | Each important feature defines trigger, processing rule, result, and state change |
| Consistency | Roles, object names, fields, statuses, permissions, and calculations do not contradict |
| Boundaries | Important validation, blocked, empty, failure, cancellation, and retry cases are covered where relevant |
| Consequential actions | Confirmation, authorization, evidence, reversal or retry, and escalation are defined as relevant |
| No fabrication | Unknown metrics and business rules remain visibly marked; technical implementation is not invented |
| Document discipline | No empty boilerplate, repeated conclusions, redundant chapters, or unrequested project plans |
| Deliverable integrity | The requested file is complete, readable, and uses the selected PRD architecture consistently |

## Writing Rules

- Use plain, direct language and stable product-native terms.
- State observable behavior instead of goals such as "improve experience".
- Describe what the product does under concrete conditions.
- Use prose for causal logic and tables for enumerable fields, states, permissions,
  calculations, and comparisons.
- Do not repeat the same rule in several feature sections; define shared rules once.
- Do not leak frameworks, database schemas, endpoints, storage choices, or code-level design.
- Do not add acceptance criteria, milestones, staffing, metrics, non-goals, market
  analysis, or competitive analysis unless requested or materially required by the domain.
- Do not include a visible "quality checklist" or narrate the drafting process in the PRD.
