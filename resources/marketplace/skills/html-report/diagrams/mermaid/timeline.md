# Timeline

Use for chronological events, release history, project milestones, and historical sequences.

## Basic Example

```mermaid
timeline
    title Company Milestones
    2020 : Founded
         : Seed funding $2M
    2021 : Series A $15M
         : 50 employees
         : Product launch
    2022 : Series B $40M
         : 200 employees
         : International expansion
    2023 : IPO preparation
         : 500 employees
```

## Syntax

```
timeline
    title [Title text]
    [Time period] : [Event 1]
                  : [Event 2]
                  : [Event 3]
```

- Each time period can have multiple events (one per `: ` line)
- Time periods are displayed in order on the axis

## Sections

```mermaid
timeline
    title Product Evolution
    section Phase 1 - MVP
        2023-Q1 : Core API built
                : Alpha testing
        2023-Q2 : Public beta launch
                : First 100 users
    section Phase 2 - Growth
        2023-Q3 : Payment integration
                : 1000 users milestone
        2023-Q4 : Mobile app released
                : Series A funding
    section Phase 3 - Scale
        2024-Q1 : Multi-region deploy
                : Enterprise features
        2024-Q2 : 10k users
                : SOC2 certified
```

## Advanced Example: Technology Adoption

```mermaid
timeline
    title Frontend Framework Evolution
    section Early Web
        1995 : JavaScript created
             : Dynamic HTML begins
        1999 : XMLHttpRequest (AJAX)
        2004 : Gmail demonstrates SPA
    section Library Era
        2006 : jQuery released
             : Simplified DOM manipulation
        2010 : Backbone.js
             : AngularJS
    section Modern Frameworks
        2013 : React (Facebook)
        2014 : Vue.js (Evan You)
        2016 : Angular 2+
             : Component-based architecture
    section Current
        2020 : Next.js mainstream
             : Svelte gains traction
        2022 : React Server Components
             : Astro & Islands architecture
        2024 : AI-assisted development
             : Framework convergence
```

## Best Practices

1. **Clear time labels** — use consistent format (dates, quarters, years)
2. **Concise events** — 3-8 words per event
3. **Use sections** — group by era, phase, or theme
4. **Limit events per period** — max 3-4 per time point
5. **Chronological order** — always earliest to latest (top to bottom)
6. **Highlight key moments** — fewer, more impactful events > exhaustive list
