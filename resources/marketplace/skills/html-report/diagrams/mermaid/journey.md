# User Journey

Use for user experience flows, customer journeys, satisfaction mapping, and service design.

## Basic Example

```mermaid
journey
    title User Onboarding Journey
    section Sign Up
        Visit landing page: 5: User
        Click "Get Started": 4: User
        Fill registration form: 3: User
        Verify email: 2: User
    section First Use
        Complete tutorial: 4: User
        Create first project: 5: User
        Invite team member: 3: User
    section Activation
        Use core feature: 5: User
        See first result: 5: User
        Share with team: 4: User
```

## Syntax

```
journey
    title [Journey title]
    section [Phase name]
        [Task description]: [score]: [actor1, actor2]
```

- **Score**: 1 (very negative) to 5 (very positive) — represents satisfaction/mood
- **Actors**: Who performs this step (comma-separated for multiple)

## Multi-Actor Journey

```mermaid
journey
    title E-commerce Purchase Flow
    section Discovery
        Search for product: 4: Customer
        Browse recommendations: 3: Customer
        Compare options: 3: Customer
    section Purchase
        Add to cart: 5: Customer
        Enter shipping info: 2: Customer
        Process payment: 3: Customer, System
        Send confirmation: 5: System
    section Fulfillment
        Pick & pack order: 4: Warehouse
        Ship order: 4: Warehouse, Carrier
        Deliver to door: 5: Carrier
        Unbox product: 5: Customer
    section Post-Purchase
        Rate product: 3: Customer
        Handle return request: 2: Customer, Support
        Process refund: 4: Support, System
```

## Developer Experience Journey

```mermaid
journey
    title Developer SDK Integration
    section Discovery
        Find documentation: 3: Developer
        Read quickstart guide: 4: Developer
        Browse API reference: 3: Developer
    section Setup
        Install SDK: 5: Developer
        Configure API keys: 2: Developer
        Set up local env: 3: Developer
    section Integration
        Write first API call: 4: Developer
        Handle authentication: 2: Developer
        Parse response data: 4: Developer
        Handle errors: 3: Developer
    section Production
        Run in staging: 4: Developer, DevOps
        Monitor performance: 3: DevOps
        Debug production issue: 2: Developer, Support
        Scale successfully: 5: DevOps
```

## Scoring Guide

| Score | Meaning | Indicator |
|-------|---------|-----------|
| 5 | Delighted | Exceeds expectations, effortless |
| 4 | Satisfied | Works well, minor friction |
| 3 | Neutral | Gets the job done, nothing special |
| 2 | Frustrated | Confusing, requires effort |
| 1 | Angry | Broken, blocked, wants to quit |

## Best Practices

1. **3-5 sections** — represent major phases of the journey
2. **3-5 tasks per section** — enough detail without overwhelming
3. **Honest scores** — reflect real user sentiment, not aspirational targets
4. **Identify pain points** — scores 1-2 are where to focus improvement
5. **Multiple actors** — shows handoffs and collaboration points
6. **Action-oriented tasks** — use verb phrases ("Submit form", "Wait for approval")
7. **Chronological flow** — order tasks as they actually happen
