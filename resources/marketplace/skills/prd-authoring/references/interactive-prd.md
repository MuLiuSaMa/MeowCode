# Prototype-Centered Interactive PRD

Use this reference when one persistent clickable prototype is the primary review
surface and linked requirement text supports product and implementation review.
The deliverable is one self-contained HTML file.

## Responsibility

This reference owns both:

- product reasoning, scope, business rules, and requirement depth;
- the PRD-specific HTML shell, prototype-document linkage, interaction behavior,
  responsive layout, text mode, and accessibility.

Do not invoke a general report-writing skill to decide the PRD architecture.

## Product Reasoning Before Rendering

Derive the prototype from product decisions rather than visual improvisation.

### Product Contract

Define internally:

1. Primary user and core job
2. Trigger that starts the journey
3. Completion condition visible or persisted when the job is done
4. Trust information needed before consequential action
5. System responsibility for recording, calculating, routing, or communicating
6. User responsibility for supplying, confirming, or resolving information
7. Shared business object connecting roles, such as an order, ticket, task, case,
   application, or document

Every major feature should follow this chain:

```text
Evidence or observed problem
→ affected user and moment
→ product decision
→ prototype behavior
→ requirement rule
→ observable outcome
```

### Scope the Smallest Complete Journey

| Priority | Definition |
|---|---|
| P0 | Required to enter, complete, or recover the core journey |
| P1 | Removes a major operational burden or trust barrier after P0 works |
| P2 | Optimization, personalization, growth, convenience, or advanced administration |

Demonstrate all P0 behavior and only the P1 behavior needed to understand the
product. Do not add speculative screens to make the prototype look complete.

For every candidate feature ask:

- Which user problem does it resolve?
- Where does it enter the core journey?
- What breaks if it is removed?
- Is it confirmed, a product judgment, or an assumption?

### Roles, Objects, and States

For multi-role or consequential workflows, derive:

| Model | Required decisions |
|---|---|
| Role | Goal, visibility, allowed changes, and restrictions |
| Object | Creator, key fields, lifecycle owner, and related objects |
| State | Current state, trigger, preconditions, next state, feedback, and recovery |

Use these models to prevent contradictions. Include a table in the document only
when readers need it.

### Consequential Actions

For money, ownership, permissions, publishing, deletion, approval, compliance, or
other irreversible changes, define as relevant:

- authorized actor and preconditions;
- confirmation and duplicate-action handling;
- success evidence and audit record;
- cancellation, reversal, timeout, and retry behavior;
- notification recipients;
- manual fallback or escalation.

## Product Blueprint

Before authoring HTML, derive:

| Item | Decision |
|---|---|
| Primary user | Who operates the product and in what context |
| Core job | The outcome the prototype must make possible |
| Happy path | Entry through completion |
| Recovery path | The most important blocked or failed route |
| Completion condition | State proving the job finished |
| Shared object | Object whose lifecycle drives the flow |
| Key screens | Usually 3-7 screens or major states |
| Critical states | Default plus relevant loading, empty, success, error, disabled, or permission-limited states |
| P0 scope | Features needed for completion and recovery |
| Feature IDs | Stable IDs shared by prototype and requirement sections |

Do not expose this blueprint as a generic planning chapter.

## Deliverable Architecture

The HTML contains:

```text
┌─────────────────────────────────────────────────────────┐
│ Fixed top bar: title, version, status, mode switch      │
├──────────────────────┬──────────────────────────────────┤
│ Persistent prototype │ Tabbed PRD content               │
│ Phone/browser frame  │ Overview | Design | Detail | Rules│
├──────────────────────┴──────────────────────────────────┤
│ Link feedback and focus state                           │
└─────────────────────────────────────────────────────────┘
```

Also provide a text mode that assembles the complete PRD into a scrollable,
print-friendly document.

### Frame Selection

| Product | Frame | Default layout |
|---|---|---|
| Mobile app or mini-program | Phone frame with status/navigation areas | Narrow fixed prototype plus flexible document |
| Desktop web product | Browser frame with route context | Approximately equal split |
| Tablet or cross-device | Scaled browser/app frame | Adaptive split |

Do not place a desktop product inside a phone shell. The prototype should dominate
enough space to remain inspectable.

## Right-Side PRD Content

Use three to five non-empty tabs:

| Tab | Required | Content |
|---|---|---|
| Overview | Yes | Problem, goals, primary user, core job, completion condition, P0 scope, assumptions |
| Design or Research | Conditional | Core journey, product decisions, role/object model, supplied evidence |
| Detail | Yes | Linked functional requirement sections; most of the content |
| Rules | Conditional | Shared permissions, states, calculations, fields, timing, and exceptions |
| Metrics or Plan | Explicit request only | Instrumentation, milestones, or staffing |

The Overview must contain substantive context, not title metadata or slogans.
Organize Detail by user task or business capability rather than arbitrary visual regions.

### Feature Section Contract

Each linked requirement uses a unique stable ID:

```html
<section class="feature-section" id="feature-submit-request">
  <h3>Submit request</h3>
  <!-- purpose, interaction flow, rules, states, and mapping -->
</section>
```

Each section covers enough of the following to remove ambiguity:

1. Purpose and user value
2. Page or component responsibility
3. Concrete action-to-response flow
4. Trigger, processing rules, result, and state change
5. Validation and boundary behavior
6. Field rules for substantial forms
7. State transitions for lifecycle behavior
8. Permissions for role differences
9. Prototype screen or component demonstrating the behavior

Use prose for causal logic and tables for enumerable rules. Do not force every
feature into the same subsection template.

## Left-Side Prototype

The prototype must:

- cover every page or state required by the P0 journey;
- use realistic product-native labels and sample values;
- expose meaningful default, success, blocked, empty, loading, or error states as relevant;
- update visible state after actions instead of relying on alerts;
- support reversible exploration through back, close, reset, cancel, or edit behavior;
- bind every visually clickable element to valid behavior;
- show a deliberate unavailable response for visible out-of-scope entries;
- use one conceptual state model for page, selected object, form values, status,
  permissions, filters, and active workflow step.

Do not use Lorem ipsum, generic placeholder cards, invented critical metrics, or
dead controls.

## Prototype-Document Linkage

Use the same stable feature ID on both sides:

```html
<button data-link="feature-submit-request">Submit</button>
<section class="feature-section" id="feature-submit-request">...</section>
```

Required behavior:

1. Clicking or focusing a linked prototype element activates the matching Detail tab.
2. The matching requirement section scrolls into view and receives a visible focus state.
3. Selecting a requirement section highlights the corresponding prototype area when possible.
4. A prototype page may contain several feature links.
5. A feature ID is unique in requirement content.
6. Splash, loading, and transitional screens may remain unlinked.
7. Text mode embeds a prototype page only in its first matching feature section.

## Navigation and State Integrity

- Every `navigate('page-x')` target must have a corresponding page or state.
- Every Detail feature must have a reachable prototype page, state, or linked region.
- Hover styling or `cursor: pointer` implies working behavior.
- Buttons should add, edit, filter, validate, submit, approve, cancel, retry, or
  transition state realistically.
- Avoid `alert()` as the primary product response.
- Preserve valid form input when recoverable validation or network errors occur.

## HTML Requirements

- Produce one self-contained `.html` file with inline CSS and JavaScript.
- Do not require a CDN, package manager, build step, API, or local server.
- Keep prototype and document content in the HTML source; do not fetch them at runtime.
- Use semantic controls, keyboard focus, labels, sufficient contrast, and visible focus states.
- Keep body text at least 14px and captions at least 12px.
- Constrain tables in scrollable wrappers on narrow screens.
- Collapse split view into a coherent single-column sequence on mobile.
- Text mode must restore normal page scrolling and hide split-view-only controls.
- Print styles should hide interactive chrome and preserve readable section boundaries.

## Text Mode

Text mode is a complete long-form PRD:

- title and document metadata appear once at the top;
- tab contents appear in logical order without duplicated headings;
- linked prototype pages appear inside their primary feature sections;
- long prototype pages use fixed-height internal scrolling;
- feature sections retain stable IDs and usable interactions where possible;
- the page is scrollable, printable, and readable without the split layout.

## Content Anti-Patterns

Rewrite:

- page inventories without behavior or rules;
- the user's feature list paraphrased as requirements;
- happy-path-only flows for important actions;
- business rules invented to justify a UI component;
- fabricated limits, SLAs, fees, conversion rates, or research findings;
- universal login, settings, notifications, admin, and analytics screens;
- duplicated or contradictory status, permission, and calculation definitions;
- database, endpoint, framework, or storage decisions.

## Mode-Specific Final Checks

| Check | Pass condition |
|---|---|
| Core journey | P0 has a clear trigger, completion condition, and meaningful recovery path |
| Feature mapping | Every Detail feature has a matching prototype area and unique stable ID |
| Navigation | Every navigation reference resolves; no visually clickable control is dead |
| State behavior | Important actions visibly change realistic product state |
| Requirement depth | Linked sections explain decisions, rules, states, and boundaries without fixed-length padding |
| Evidence | Major decisions trace to evidence, product judgment, or a marked assumption |
| Consistency | Roles, objects, labels, statuses, permissions, and calculations agree across both sides |
| Consequential actions | Confirmation, evidence, retry or reversal, and escalation are defined as relevant |
| Responsive integrity | Split view, mobile layout, text mode, and print mode remain readable and non-overlapping |
| Self-containment | The file works without external assets, network requests, or a build step |
