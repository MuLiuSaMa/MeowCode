# Mindmap

Use for brainstorming, concept hierarchies, topic decomposition, and knowledge organization.

## Basic Example

```mermaid
mindmap
    root((Project Planning))
        Goals
            Increase revenue
            Reduce churn
            Expand market
        Resources
            Engineering team
            Budget $500k
            Timeline 6 months
        Risks
            Technical debt
            Talent shortage
            Market shift
```

## Node Shapes

| Syntax | Shape | Use For |
|--------|-------|---------|
| `root((text))` | Circle | Central topic |
| `root[text]` | Square | Structured root |
| `root)text(` | Cloud/Bang | Creative root |
| `id(text)` | Rounded | Sub-topics |
| `id[text]` | Square | Concrete items |
| `id))text((` | Hexagon | Categories |
| Default (just text) | Pill | Leaf items |

## Hierarchy by Indentation

Depth is determined by indentation level (spaces):

```mermaid
mindmap
    root((System Design))
        Frontend
            React SPA
            Next.js SSR
            Mobile App
                iOS
                Android
        Backend
            API Gateway
            Microservices
                User Service
                Order Service
                Payment Service
            Message Queue
        Infrastructure
            AWS
                ECS
                RDS
                S3
            Monitoring
                Prometheus
                Grafana
```

## Advanced Example: Technical Decision

```mermaid
mindmap
    root((Database Selection))
        Requirements
            High write throughput
            ACID transactions
            Horizontal scaling
            JSON support
        Options
            PostgreSQL
                Mature & stable
                Rich extensions
                JSONB support
                Vertical scaling only
            CockroachDB
                Distributed SQL
                Strong consistency
                Auto-sharding
                Higher latency
            MongoDB
                Schema flexible
                Native sharding
                Eventual consistency
                No joins
        Evaluation Criteria
            Performance benchmarks
            Operational complexity
            Team expertise
            Cost at scale
        Decision
            PostgreSQL for MVP
            Plan migration path
```

## Example: Sprint Retrospective

```mermaid
mindmap
    root((Sprint 42 Retro))
        What went well
            Shipped on time
            Good test coverage
            Team collaboration
        What could improve
            Too many meetings
            Unclear requirements
            Late code reviews
        Action items
            Block focus time
            Spec review before sprint
            Review SLA 24h
```

## Best Practices

1. **Central topic as root** — one clear main concept
2. **3-5 main branches** — too many branches loses focus
3. **Consistent depth** — keep branches roughly same depth (2-4 levels)
4. **Short labels** — 1-4 words per node
5. **Balance** — distribute sub-topics evenly across branches
6. **Use shapes for emphasis** — circle for root, different shapes for key nodes
