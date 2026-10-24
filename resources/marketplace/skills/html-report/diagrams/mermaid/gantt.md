# Gantt Chart

Use for project planning, sprint scheduling, release timelines, and task dependencies.

## Basic Example

```mermaid
gantt
    title Project Timeline
    dateFormat YYYY-MM-DD
    axisFormat %m/%d

    section Design
    Research        :done, d1, 2024-01-01, 7d
    Wireframes      :done, d2, after d1, 5d
    Prototyping     :active, d3, after d2, 10d

    section Development
    Backend API     :dev1, after d2, 15d
    Frontend UI     :dev2, after d3, 12d
    Integration     :dev3, after dev1, 5d

    section Testing
    QA Testing      :test1, after dev3, 7d
    UAT             :test2, after test1, 5d
```

## Configuration Directives

| Directive | Example | Description |
|-----------|---------|-------------|
| `title` | `title Sprint 42` | Chart title |
| `dateFormat` | `dateFormat YYYY-MM-DD` | Input date format |
| `axisFormat` | `axisFormat %Y-%m-%d` | Display format on axis |
| `tickInterval` | `tickInterval 1week` | Axis tick spacing |
| `excludes` | `excludes weekends` | Skip non-working days |
| `todayMarker` | `todayMarker stroke-width:3px,stroke:#f00` | Today line style |

## Task Syntax

```
Task name : [status], [id], [start], [duration/end]
```

| Field | Options |
|-------|---------|
| Status | `done`, `active`, `crit` (critical path), or omit |
| ID | Alphanumeric identifier for dependencies |
| Start | Date (`2024-01-15`) or `after taskId` |
| Duration/End | `7d`, `2w`, `1m`, or end date |

### Milestones

```mermaid
gantt
    dateFormat YYYY-MM-DD
    section Milestones
    MVP Launch       :milestone, m1, 2024-03-01, 0d
    Beta Release     :milestone, m2, 2024-04-15, 0d
    GA Release       :milestone, m3, 2024-06-01, 0d
```

## Task States

```mermaid
gantt
    dateFormat YYYY-MM-DD

    section States Demo
    Completed task    :done, s1, 2024-01-01, 5d
    Active task       :active, s2, 2024-01-06, 5d
    Critical task     :crit, s3, after s2, 3d
    Future task       :s4, after s3, 5d
    Crit + Active     :crit, active, s5, after s4, 4d
```

## Dependencies

```mermaid
gantt
    dateFormat YYYY-MM-DD

    section Pipeline
    Build         :b1, 2024-01-01, 2d
    Unit Tests    :t1, after b1, 1d
    Integration   :t2, after b1, 2d
    Deploy Staging:d1, after t1, 1d
    E2E Tests     :t3, after d1, 2d
    Deploy Prod   :crit, d2, after t2 t3, 1d
```

Multiple dependencies: `after task1 task2` — starts after both complete.

## Sections

Group tasks by team, phase, or module:

```mermaid
gantt
    title Feature Development
    dateFormat YYYY-MM-DD

    section Backend Team
    API Design       :done, be1, 2024-01-08, 3d
    Implementation   :active, be2, after be1, 10d
    API Tests        :be3, after be2, 3d

    section Frontend Team
    UI Design        :done, fe1, 2024-01-08, 5d
    Components       :fe2, after fe1, 8d
    Integration      :fe3, after fe2 be2, 5d

    section QA Team
    Test Plan        :qa1, 2024-01-08, 3d
    Test Execution   :qa2, after fe3 be3, 5d
    Sign-off         :milestone, qa3, after qa2, 0d
```

## Excluding Days

```mermaid
gantt
    title Sprint (No Weekends)
    dateFormat YYYY-MM-DD
    excludes weekends

    section Work
    Task A :a1, 2024-01-08, 5d
    Task B :a2, after a1, 3d
```

## Advanced Example: Product Launch

```mermaid
gantt
    title Product Launch Plan
    dateFormat YYYY-MM-DD
    axisFormat %b %d
    excludes weekends

    section Planning
    Market Research      :done, p1, 2024-01-15, 10d
    Competitor Analysis  :done, p2, 2024-01-15, 7d
    Strategy Document    :done, p3, after p1 p2, 5d
    Stakeholder Review   :milestone, p4, after p3, 0d

    section Product
    Feature Freeze       :crit, done, f1, after p4, 1d
    Bug Fixes            :crit, f2, after f1, 10d
    Performance Tuning   :f3, after f1, 8d
    Security Audit       :crit, f4, after f2, 5d
    Release Candidate    :milestone, crit, f5, after f4, 0d

    section Marketing
    Landing Page         :m1, after p3, 15d
    Blog Post            :m2, after p3, 5d
    Email Campaign       :m3, after m1, 5d
    Social Media         :m4, after m2, 10d
    Press Kit            :m5, after m1, 3d

    section Launch
    Soft Launch (10%)    :crit, l1, after f5 m3, 3d
    Monitor & Fix        :crit, l2, after l1, 5d
    Full Rollout         :crit, milestone, l3, after l2, 0d
    Post-launch Review   :l4, after l3, 3d
```

## Best Practices

1. **Use sections** — group by team, phase, or workstream
2. **Mark critical path** — `crit` highlights what blocks the deadline
3. **Show dependencies** — use `after taskId` to reveal bottlenecks
4. **Keep task names short** — 2-4 words max
5. **Use milestones** — mark key decision points and deliverables
6. **Exclude weekends** — `excludes weekends` for realistic timelines
7. **Assign IDs** — every task should have an ID for dependency referencing
8. **Use `axisFormat`** — choose date display that matches the time scale
