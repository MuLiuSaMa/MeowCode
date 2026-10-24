# Sequence Diagram

Use for API calls, protocol flows, microservice interactions, and time-ordered messaging between actors.

## Basic Example

```mermaid
sequenceDiagram
    participant C as Client
    participant S as Server
    participant DB as Database

    C->>S: POST /api/login
    activate S
    S->>DB: Query user
    DB-->>S: User record
    S-->>C: 200 OK + token
    deactivate S
```

## Participants

```mermaid
sequenceDiagram
    participant A as Alice
    actor B as Bob
    participant S as System
```

- `participant` — box shape (for systems/services)
- `actor` — stick figure (for people)
- Use `as` for short display names

## Message Types

| Syntax | Meaning | Use For |
|--------|---------|---------|
| `->>` | Solid arrow | Synchronous request |
| `-->>` | Dashed arrow | Response / return |
| `--)` | Solid open arrow | Async message (fire & forget) |
| `--x` | Dashed X | Lost message |
| `->>+` | Arrow + activate | Request that starts processing |
| `-->>-` | Arrow + deactivate | Response that ends processing |

## Activation Bars

Show processing time with explicit or inline activation:

```mermaid
sequenceDiagram
    Client->>+Server: Request
    Server->>+DB: Query
    DB-->>-Server: Result
    Server-->>-Client: Response
```

## Interaction Fragments

### Alternatives (if/else)

```mermaid
sequenceDiagram
    Client->>Server: Login(user, pass)
    alt Valid credentials
        Server-->>Client: 200 OK + token
    else Invalid credentials
        Server-->>Client: 401 Unauthorized
    end
```

### Loops

```mermaid
sequenceDiagram
    Client->>Server: Poll status
    loop Every 5 seconds
        Server-->>Client: Status: pending
    end
    Server-->>Client: Status: complete
```

### Optional

```mermaid
sequenceDiagram
    Client->>Server: Get user profile
    opt Has avatar
        Server->>CDN: Fetch avatar URL
        CDN-->>Server: Signed URL
    end
    Server-->>Client: Profile data
```

### Parallel

```mermaid
sequenceDiagram
    Server->>Client: Processing started
    par Fetch user data
        Server->>UserDB: Get user
    and Fetch orders
        Server->>OrderDB: Get orders
    and Fetch recommendations
        Server->>RecEngine: Get recs
    end
    Server-->>Client: Aggregated response
```

### Critical Region

```mermaid
sequenceDiagram
    critical Establish connection
        Client->>Server: Connect
        Server-->>Client: ACK
    option Network timeout
        Client->>Client: Retry with backoff
    option Server down
        Client->>Client: Switch to fallback
    end
```

## Notes

```mermaid
sequenceDiagram
    participant A as Service A
    participant B as Service B

    Note right of A: Prepares payload
    A->>B: Send request
    Note over A,B: TLS encrypted channel
    B-->>A: Response
    Note left of B: Logs response
```

## Highlights (rect)

```mermaid
sequenceDiagram
    participant U as User
    participant API as API Gateway
    participant Auth as Auth Service
    participant DB as Database

    rect rgb(240, 248, 255)
        Note over U,Auth: Authentication Flow
        U->>API: POST /login
        API->>Auth: Validate credentials
        Auth->>DB: Query user
        DB-->>Auth: User record
        Auth-->>API: JWT token
        API-->>U: 200 + token
    end

    rect rgb(255, 248, 240)
        Note over U,DB: Data Access Flow
        U->>API: GET /data (+ token)
        API->>Auth: Verify token
        Auth-->>API: Valid
        API->>DB: Query data
        DB-->>API: Results
        API-->>U: 200 + data
    end
```

## Numbering

```mermaid
sequenceDiagram
    autonumber
    Alice->>Bob: Hello
    Bob->>Alice: Hi
    Alice->>Bob: How are you?
```

## Advanced Example: OAuth2 Flow

```mermaid
sequenceDiagram
    autonumber
    participant U as User
    participant App as Client App
    participant AS as Auth Server
    participant RS as Resource Server

    U->>App: Click "Login"
    App->>AS: Authorization Request<br/>(client_id, redirect_uri, scope)
    AS->>U: Login Page
    U->>AS: Credentials
    AS->>App: Authorization Code (via redirect)
    App->>AS: Token Request<br/>(code, client_secret)
    AS-->>App: Access Token + Refresh Token
    App->>RS: API Request (+ Bearer token)
    RS-->>App: Protected Resource
    App-->>U: Display Data
```

## Best Practices

1. **Limit participants** — max 5-7 per diagram; split if more
2. **Always show returns** — every request should have a matching response
3. **Use activation bars** — clearly shows which service is "working"
4. **Label messages clearly** — include HTTP methods, event names, or action descriptions
5. **Group with rect** — highlight logical phases with colored rectangles
6. **Use autonumber** — helpful for referencing specific steps in documentation
7. **Alias long names** — `participant GW as API Gateway` keeps the diagram compact
8. **Show error paths** — use `alt` for success/failure branches
