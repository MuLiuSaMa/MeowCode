# Entity Relationship Diagram

Use for database design, data models, schema visualization, and domain modeling.

## Basic Example

```mermaid
erDiagram
    USER ||--o{ ORDER : places
    ORDER ||--|{ LINE_ITEM : contains
    PRODUCT ||--o{ LINE_ITEM : "ordered in"

    USER {
        int id PK
        string name
        string email UK
        datetime created_at
    }
    ORDER {
        int id PK
        int user_id FK
        decimal total
        string status
        date created_at
    }
    LINE_ITEM {
        int id PK
        int order_id FK
        int product_id FK
        int quantity
        decimal unit_price
    }
    PRODUCT {
        int id PK
        string name
        string sku UK
        decimal price
        int stock
    }
```

## Relationship Notation

Cardinality is expressed with the following symbols:

| Left | Right | Meaning |
|------|-------|---------|
| `│|` | `│|` | Exactly one |
| `│|` | `o|` | Zero or one |
| `│|` | `}|` | One or more |
| `│|` | `}o` | Zero or more |

### Common Patterns

| Syntax | Meaning |
|--------|---------|
| `A │|--│| B` | One-to-one (mandatory both sides) |
| `A │|--o| B` | One-to-one (B optional) |
| `A │|--o{ B` | One-to-many (B optional) |
| `A │|--│{ B` | One-to-many (B mandatory) |
| `A }o--o{ B` | Many-to-many (both optional) |

### Relationship Labels

Always label with a verb describing the relationship:

```mermaid
erDiagram
    CUSTOMER ||--o{ ORDER : places
    ORDER ||--|{ PAYMENT : "is paid by"
    EMPLOYEE ||--o{ ORDER : fulfills
```

## Attribute Syntax

```
ENTITY {
    type name constraint
}
```

| Constraint | Meaning |
|-----------|---------|
| `PK` | Primary Key |
| `FK` | Foreign Key |
| `UK` | Unique Key |

Common types: `int`, `string`, `text`, `decimal`, `float`, `date`, `datetime`, `boolean`, `uuid`, `json`

## Advanced Example: SaaS Platform

```mermaid
erDiagram
    TENANT ||--|{ USER : "has members"
    TENANT ||--o{ WORKSPACE : owns
    USER ||--o{ WORKSPACE_MEMBER : "participates in"
    WORKSPACE ||--|{ WORKSPACE_MEMBER : "has members"
    WORKSPACE ||--o{ PROJECT : contains
    PROJECT ||--o{ TASK : includes
    TASK }o--o| USER : "assigned to"
    TASK ||--o{ COMMENT : has
    COMMENT }o--|| USER : "authored by"

    TENANT {
        uuid id PK
        string name
        string plan
        date trial_ends_at
        datetime created_at
    }
    USER {
        uuid id PK
        uuid tenant_id FK
        string email UK
        string name
        string role
        datetime last_login
    }
    WORKSPACE {
        uuid id PK
        uuid tenant_id FK
        string name
        string description
        boolean archived
    }
    WORKSPACE_MEMBER {
        uuid id PK
        uuid workspace_id FK
        uuid user_id FK
        string role
        datetime joined_at
    }
    PROJECT {
        uuid id PK
        uuid workspace_id FK
        string name
        string status
        date deadline
    }
    TASK {
        uuid id PK
        uuid project_id FK
        uuid assignee_id FK
        string title
        text description
        string priority
        string status
        date due_date
    }
    COMMENT {
        uuid id PK
        uuid task_id FK
        uuid author_id FK
        text body
        datetime created_at
    }
```

## Design Patterns

### Self-referencing (Tree Structure)

```mermaid
erDiagram
    CATEGORY ||--o{ CATEGORY : "parent of"
    CATEGORY {
        int id PK
        int parent_id FK
        string name
        int depth
    }
```

### Polymorphic Association

```mermaid
erDiagram
    POST ||--o{ COMMENT : has
    IMAGE ||--o{ COMMENT : has
    COMMENT {
        int id PK
        string commentable_type
        int commentable_id
        text body
    }
```

### Audit Trail

```mermaid
erDiagram
    ENTITY ||--o{ AUDIT_LOG : "tracked by"
    USER ||--o{ AUDIT_LOG : performs
    AUDIT_LOG {
        int id PK
        string entity_type
        int entity_id
        int user_id FK
        string action
        json old_values
        json new_values
        datetime created_at
    }
```

## Best Practices

1. **Name entities in UPPER_CASE** or PascalCase — be consistent
2. **Always label relationships** with a verb phrase
3. **Include PK/FK/UK constraints** — clarifies schema intent
4. **Show only key columns** — not every field; focus on domain-relevant attributes
5. **Use meaningful types** — `uuid` vs `int`, `decimal` vs `float`
6. **Direction matters** — read relationships left-to-right as sentences ("User places Order")
7. **Break large schemas into sub-diagrams** — by bounded context or module
