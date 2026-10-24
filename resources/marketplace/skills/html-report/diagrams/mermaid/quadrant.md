# Quadrant Chart

Use for 2D classification, priority matrices, strategic positioning, and comparative analysis.

## Basic Example

```mermaid
quadrantChart
    title Eisenhower Matrix
    x-axis Urgent --> Not Urgent
    y-axis Not Important --> Important
    quadrant-1 Schedule
    quadrant-2 Do First
    quadrant-3 Delegate
    quadrant-4 Eliminate
    Deploy hotfix: [0.9, 0.8]
    Write docs: [0.2, 0.6]
    Reply emails: [0.8, 0.2]
    Clean desk: [0.2, 0.1]
    Sprint planning: [0.6, 0.9]
    Code review: [0.7, 0.7]
```

## Syntax

```
quadrantChart
    title [Chart title]
    x-axis [Low label] --> [High label]
    y-axis [Low label] --> [High label]
    quadrant-1 [Top-right label]
    quadrant-2 [Top-left label]
    quadrant-3 [Bottom-left label]
    quadrant-4 [Bottom-right label]
    [Point name]: [x, y]
```

- Coordinates range from `0.0` to `1.0`
- Quadrant numbering: 1=top-right, 2=top-left, 3=bottom-left, 4=bottom-right

## Technology Radar Example

```mermaid
quadrantChart
    title Build vs Buy Decision
    x-axis Low Complexity --> High Complexity
    y-axis Low Strategic Value --> High Strategic Value
    quadrant-1 Build Custom
    quadrant-2 Partner/Integrate
    quadrant-3 Use SaaS
    quadrant-4 Open Source + Customize
    Auth system: [0.4, 0.85]
    Payment processing: [0.75, 0.7]
    Email sending: [0.3, 0.2]
    Analytics dashboard: [0.6, 0.5]
    Core ML model: [0.9, 0.95]
    CMS: [0.5, 0.3]
    Monitoring: [0.4, 0.4]
    Search engine: [0.7, 0.45]
```

## Team Skills Matrix

```mermaid
quadrantChart
    title Team Skill Assessment
    x-axis Low Proficiency --> High Proficiency
    y-axis Low Business Need --> High Business Need
    quadrant-1 Leverage
    quadrant-2 Invest & Train
    quadrant-3 Deprioritize
    quadrant-4 Maintain
    React: [0.9, 0.85]
    Kubernetes: [0.4, 0.8]
    Go: [0.3, 0.7]
    Python: [0.8, 0.5]
    Rust: [0.2, 0.6]
    SQL: [0.85, 0.9]
    GraphQL: [0.5, 0.4]
    WebAssembly: [0.1, 0.3]
```

## Configuration

```mermaid
%%{init: {
    'quadrantChart': {
        'chartWidth': 500,
        'chartHeight': 500,
        'titleFontSize': 20,
        'pointRadius': 6,
        'pointTextPadding': 5,
        'quadrantLabelFontSize': 14
    }
}}%%
quadrantChart
    title Example
    x-axis Low --> High
    y-axis Low --> High
    quadrant-1 Q1
    quadrant-2 Q2
    quadrant-3 Q3
    quadrant-4 Q4
    Point A: [0.7, 0.8]
    Point B: [0.3, 0.4]
```

## Best Practices

1. **Clear axis labels** — both ends should describe opposing concepts
2. **Meaningful quadrant names** — action-oriented labels (Do, Schedule, Delegate, Eliminate)
3. **5-12 data points** — too few lacks insight, too many creates clutter
4. **Spread distribution** — ensure points aren't all clustered in one quadrant
5. **Actionable** — each quadrant should imply a clear action or decision
6. **Descriptive point names** — 1-3 words that identify the item
