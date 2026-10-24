# State Diagram

Use for finite state machines, lifecycle management, workflow states, and protocol states.

## Basic Example

```mermaid
stateDiagram-v2
    [*] --> Idle
    Idle --> Processing : submit
    Processing --> Success : complete
    Processing --> Failed : error
    Failed --> Idle : retry
    Success --> [*]
```

## Syntax Reference

| Element | Syntax |
|---------|--------|
| Start state | `[*] --> State` |
| End state | `State --> [*]` |
| Transition | `State1 --> State2 : event` |
| Composite state | `state Name { ... }` |
| Choice | `state name <<choice>>` |
| Fork | `state name <<fork>>` |
| Join | `state name <<join>>` |
| Note | `note right of State : text` |

## Composite States

Nest states inside other states:

```mermaid
stateDiagram-v2
    [*] --> Active

    state Active {
        [*] --> Idle
        Idle --> Processing : request
        Processing --> Idle : done
    }

    Active --> Suspended : suspend
    Suspended --> Active : resume
    Active --> [*] : terminate
```

## Concurrency

Show parallel states with `--`:

```mermaid
stateDiagram-v2
    [*] --> Active

    state Active {
        [*] --> Running

        state Running {
            state "Network Module" as net {
                [*] --> Connected
                Connected --> Disconnected : timeout
                Disconnected --> Connected : reconnect
            }
            --
            state "UI Module" as ui {
                [*] --> Rendering
                Rendering --> Idle : done
                Idle --> Rendering : update
            }
        }
    }
```

## Choice (Conditional Branching)

```mermaid
stateDiagram-v2
    [*] --> Evaluating
    Evaluating --> check

    state check <<choice>>
    check --> Approved : score >= 80
    check --> Rejected : score < 40
    check --> Review : 40 <= score < 80

    Approved --> [*]
    Rejected --> [*]
    Review --> Evaluating : reassess
```

## Fork and Join (Parallel Execution)

```mermaid
stateDiagram-v2
    [*] --> Start
    Start --> fork_state

    state fork_state <<fork>>
    fork_state --> TaskA
    fork_state --> TaskB
    fork_state --> TaskC

    TaskA --> join_state
    TaskB --> join_state
    TaskC --> join_state

    state join_state <<join>>
    join_state --> Complete
    Complete --> [*]
```

## Notes

```mermaid
stateDiagram-v2
    [*] --> Pending
    Pending --> Processing : approve

    note right of Pending
        Waiting for admin approval.
        Timeout after 72 hours.
    end note

    note left of Processing : Auto-scales resources
```

## Styling

```mermaid
stateDiagram-v2
    [*] --> Active
    Active --> Degraded : partial failure
    Degraded --> Failed : full failure
    Active --> [*] : shutdown

    classDef healthy fill:#4CAF50,color:#fff
    classDef warning fill:#FF9800,color:#fff
    classDef danger fill:#F44336,color:#fff

    class Active healthy
    class Degraded warning
    class Failed danger
```

## Advanced Example: Order Lifecycle

```mermaid
stateDiagram-v2
    [*] --> Draft

    Draft --> Submitted : customer submits
    Submitted --> check

    state check <<choice>>
    check --> PaymentPending : valid
    check --> Draft : invalid (return to edit)

    PaymentPending --> Paid : payment received
    PaymentPending --> Cancelled : timeout 30min

    state Fulfillment {
        [*] --> Picking
        Picking --> Packing : items collected
        Packing --> Shipped : label printed
        Shipped --> [*]
    }

    Paid --> Fulfillment : begin fulfillment
    Fulfillment --> Delivered : carrier confirmed

    Delivered --> Completed : no dispute
    Delivered --> Disputed : customer dispute

    Disputed --> Refunded : refund approved
    Disputed --> Completed : dispute rejected

    Cancelled --> [*]
    Completed --> [*]
    Refunded --> [*]

    note right of PaymentPending
        Auto-cancel if not paid
        within 30 minutes
    end note
```

## Direction

```mermaid
stateDiagram-v2
    direction LR
    [*] --> A
    A --> B
    B --> [*]
```

## Best Practices

1. **Always include `[*]` start and end** — makes entry/exit points explicit
2. **Label all transitions** — every arrow should say what triggers it
3. **Use composite states** — nest to reduce clutter (keep flat count ≤ 10)
4. **Use choice pseudo-states** — for branching logic, not multiple transitions from one state
5. **Use v2 syntax** — `stateDiagram-v2` has better layout and features
6. **Color by category** — healthy/warning/error states colored accordingly
7. **Add notes for side effects** — timeouts, notifications, auto-actions
