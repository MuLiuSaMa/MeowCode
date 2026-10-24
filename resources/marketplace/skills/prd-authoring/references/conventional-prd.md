# Conventional PRD

Use this reference for a chapter-based PRD. The document is the primary review
surface; prototypes or diagrams appear inside the relevant functional sections.

## Depth Selection

Choose depth from scope and risk:

| Scope | Default depth | Treatment |
|---|---|---|
| Small iteration | Light | Brief context plus complete changed behavior and affected rules |
| New module | Medium | Context, goals, scope, complete functional modules, shared rules |
| New product or major workflow | Heavy | Product contract, role and object models, broader dependencies, complete functional requirements |
| Regulated or consequential flow | Risk-adjusted | Add permissions, audit, confirmation, reversal, and exception detail regardless of size |

Length is not a quality target. A small requirement can be complete in a few
sections; a complex workflow may require substantial detail.

## Module Selection

Use only modules justified by the requirement:

| Module | Light | Medium | Heavy |
|---|---|---|---|
| Background and problem | Required, brief | Required | Required, evidence-linked |
| Goals | Merge into background | Required | Required |
| Scope | Required | Required | Required with P0/P1 boundaries |
| Functional requirements | Required core | Required core | Required core |
| Shared rules and exceptions | As needed | As needed | Usually required |
| Roles, objects, states | As needed | As needed | Required for multi-role workflows |
| Market or competitive context | Omit | Only when it changes a product decision | Only when supported or requested |
| Glossary | Omit | Only for ambiguous domain terms | As needed |

Default-off modules:

- acceptance criteria;
- non-goals;
- metrics and instrumentation;
- milestones, staffing, and iteration plans;
- operations or launch plans;
- appendices and reference lists.

Include a default-off module only when the user requests it or when a regulated
requirement cannot be understood without it. Do not add sections merely to make
the document look formal.

## Recommended Architecture

Adapt the headings to the content. A typical medium PRD uses:

1. Background and goals
2. Scope
3. Core flow or product model
4. Functional requirements
5. Shared rules and exceptions, when needed
6. Open questions, only for unresolved decisions that remain material

The functional requirements section should occupy most of the document.

## Background and Goals

Connect the observed problem to a product response:

```text
Evidence or observed problem
→ affected user and moment
→ product decision
→ expected observable outcome
```

Do not fabricate quantitative goals. When the user provides no defensible target,
state a qualitative outcome in observable terms. For example, prefer "Users can
recover a rejected submission without re-entering valid fields" over "Improve
submission experience".

## Scope

State the smallest complete journey:

- entry condition;
- P0 actions needed to finish the job;
- completion evidence visible to the user;
- recovery path for the most important failure;
- relevant P1 support;
- excluded speculative behavior only when omission could create disagreement.

Avoid listing login, settings, notifications, analytics, and administration by
habit. Include them only when they participate in the core journey.

## Functional Requirement Organization

Choose one structure:

### Structure A: By Task or Module

Use when the product contains three or more meaningful tasks or modules. Give each
module its own subsection and embedded demo when interaction is important.

Each module should cover, in the clearest order:

1. **Purpose**: user outcome and why the module exists.
2. **Layout**: regions and responsibilities when a UI is involved.
3. **Trigger**: who can start the action and under what conditions.
4. **Processing rules**: decisions, validations, calculations, ordering, and dependencies.
5. **Result and state change**: persisted outcome, visible feedback, and notifications.
6. **Interaction flow**: action-to-response sequence when not evident from a demo.
7. **Fields**: required, type, range, default, editability, and validation when relevant.
8. **States**: allowed transitions and prohibited operations when relevant.
9. **Permissions**: visibility, operability, ownership, and data boundaries when relevant.
10. **Exceptions**: blocked, empty, conflict, timeout, cancellation, retry, and recovery cases.

### Structure B: Requirement Table

Use for tightly coupled behavior or five or fewer flat requirements. A useful table
contains:

| ID | Capability | User and trigger | Product behavior | Rules and states | Prototype or evidence |
|---|---|---|---|---|---|
| FR-01 | Stable capability name | Actor and entry condition | Trigger through result | Validation, boundary, state | Linked demo, diagram, or source |

Do not put all causal logic into an oversized table. Move complex flows into prose
or a state diagram below the row.

## Prototype and Diagram Policy

For HTML output:

- embed a clickable demo for every P0 UI module whose behavior is easier to review
  through interaction;
- make demo labels and states match the requirement text;
- show meaningful feedback and at least one alternate, blocked, empty, or error state
  when relevant;
- use stable requirement IDs to connect the demo to its functional section;
- do not create a visual demo for policy-only, calculation-only, or backend behavior
  when a table or flow diagram communicates it better.

For static output:

- use a compact flowchart for process decisions;
- use a state diagram or transition table for lifecycle behavior;
- use a simple wireframe only when layout placement materially affects the requirement.

## Shared Rules

Move rules used by several modules into one canonical section:

- role and permission matrix;
- object lifecycle and state transitions;
- calculation and rounding rules;
- cross-module validation;
- notification timing and recipients;
- audit, retention, cancellation, retry, and escalation behavior.

Reference the canonical rule by name from feature sections instead of redefining it.

## Mode-Specific Final Checks

| Check | Pass condition |
|---|---|
| Module selection | Every included chapter helps a downstream decision; default-off modules are justified |
| Feature coverage | Every in-scope capability appears once in functional requirements with a stable name or ID |
| Behavior chain | Important requirements cover trigger, processing, result, and state change |
| Prototype fit | Interaction-heavy P0 modules have a useful demo; non-visual rules are not forced into mockups |
| Shared truth | Cross-module permissions, states, and calculations have one canonical definition |
| Static fallback | Non-HTML output still communicates critical layout, flow, and lifecycle behavior |
| Open questions | Only material unresolved decisions remain; ordinary gaps are marked assumptions |
| No padding | Detail removes implementation ambiguity rather than satisfying a fixed word count |
