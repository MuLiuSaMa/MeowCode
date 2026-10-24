# Class Diagram

Use for object-oriented design, domain models, type hierarchies, and interface contracts.

## Basic Example

```mermaid
classDiagram
    class Animal {
        +String name
        +int age
        +makeSound() void
    }
    class Dog {
        +fetch() void
    }
    class Cat {
        +purr() void
    }
    Animal <|-- Dog
    Animal <|-- Cat
```

## Visibility Modifiers

| Symbol | Meaning |
|--------|---------|
| `+` | Public |
| `-` | Private |
| `#` | Protected |
| `~` | Package/Internal |

## Member Syntax

```mermaid
classDiagram
    class BankAccount {
        -String owner
        -BigDecimal balance
        +getBalance() BigDecimal
        +deposit(amount: BigDecimal) void
        +withdraw(amount: BigDecimal) bool
        -validateAmount(amount: BigDecimal)$ bool
    }
```

- `$` suffix = static method/field
- `*` suffix = abstract method
- Return type after method name

## Relationships

| Syntax | Symbol | Meaning | Example |
|--------|--------|---------|---------|
| `<│--` | Solid + closed triangle | Inheritance | Dog inherits Animal |
| `*--` | Solid + filled diamond | Composition | Car owns Engine |
| `o--` | Solid + empty diamond | Aggregation | Team has Members |
| `-->` | Solid + open arrow | Association | Student → Course |
| `..>` | Dashed + open arrow | Dependency | Controller uses Service |
| `..│>` | Dashed + closed triangle | Realization | Class implements Interface |
| `--` | Solid line | Link | Generic relationship |

### Cardinality / Multiplicity

```mermaid
classDiagram
    Customer "1" --> "*" Order : places
    Order "1" *-- "1..*" LineItem : contains
    Product "0..*" -- "0..*" Category : belongs to
```

### Relationship Labels

```mermaid
classDiagram
    classA --|> classB : Inherits
    classC --* classD : Composition
    classE --o classF : Aggregation
    classG --> classH : Association
    classI ..> classJ : Dependency
    classK ..|> classL : Realization
```

## Annotations

```mermaid
classDiagram
    class Shape {
        <<abstract>>
        +area() double*
        +perimeter() double*
    }
    class Serializable {
        <<interface>>
        +serialize() String
    }
    class Color {
        <<enumeration>>
        RED
        GREEN
        BLUE
    }
    class Singleton {
        <<service>>
        -instance$ Singleton
        +getInstance()$ Singleton
    }
```

## Namespace / Grouping

```mermaid
classDiagram
    namespace Domain {
        class User {
            +String name
            +String email
        }
        class Order {
            +Date createdAt
            +OrderStatus status
        }
    }
    namespace Infrastructure {
        class UserRepository {
            +findById(id) User
            +save(user) void
        }
        class OrderRepository {
            +findByUser(userId) List~Order~
        }
    }
    User "1" --> "*" Order
    UserRepository ..> User
    OrderRepository ..> Order
```

## Generics

```mermaid
classDiagram
    class List~T~ {
        +add(item: T) void
        +get(index: int) T
        +size() int
    }
    class Map~K,V~ {
        +put(key: K, val: V) void
        +get(key: K) V
    }
```

## Advanced Example: Repository Pattern

```mermaid
classDiagram
    class Entity {
        <<abstract>>
        #UUID id
        #DateTime createdAt
        #DateTime updatedAt
    }

    class User {
        -String email
        -String passwordHash
        -UserRole role
        +verifyPassword(raw: String) bool
    }

    class Repository~T~ {
        <<interface>>
        +findById(id: UUID) T
        +findAll() List~T~
        +save(entity: T) T
        +delete(id: UUID) void
    }

    class UserRepository {
        <<interface>>
        +findByEmail(email: String) User
    }

    class PostgresUserRepository {
        -DataSource ds
        +findById(id: UUID) User
        +findByEmail(email: String) User
        +save(entity: User) User
        +delete(id: UUID) void
    }

    class UserService {
        -UserRepository repo
        -PasswordEncoder encoder
        +register(dto: CreateUserDTO) User
        +authenticate(email: String, pass: String) Token
    }

    Entity <|-- User
    Repository~T~ <|-- UserRepository
    UserRepository <|.. PostgresUserRepository
    UserService --> UserRepository : uses
```

## Direction

```mermaid
classDiagram
    direction RL
    class A
    class B
    A --> B
```

Available: `TB` (top-bottom, default), `BT`, `LR`, `RL`

## Best Practices

1. **Show only key members** — don't list every getter/setter
2. **Label relationships** — explain what the link means
3. **Use annotations** — mark interfaces, abstract classes, enums clearly
4. **Group with namespace** — organize by layer (domain, infra, application)
5. **Include cardinality** — shows multiplicity constraints
6. **Direction** — use `LR` for wide hierarchies, `TB` for deep ones
7. **Generics** — use `~T~` syntax for parameterized types
