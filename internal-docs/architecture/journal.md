# Journal & Ledger Architecture

The Veritas Ledger operates on a strictly disciplined double-entry accounting foundation. Every financial event within the platform—regardless of how it is presented in the UI—is ultimately decomposed into a unified `journalHeader` enclosing multiple `journalLines`.

## Relational Entity-Relationship Diagram

```mermaid
erDiagram
    journalHeaders ||--|{ journalLines : "contains (1:N)"
    parties ||--o{ journalHeaders : "header-level party"
    parties ||--o{ journalLines : "line-level party"
    accounts ||--|{ journalLines : "classifies"
    dimensions ||--o{ journalLines : "department tag"
    dimensions ||--o{ journalLines : "location tag"

    journalHeaders {
        uuid id PK
        text organization_id
        varchar transaction_number
        enum transaction_type "pay_in | pay_out | journal | transfer"
        enum source "manual | import | invoice | bill | reconciliation"
        text memo
        uuid party_id FK "Vendor/Customer"
        decimal total_amount "Cached UI aggregate"
        enum status "draft | posted | voided"
    }

    journalLines {
        uuid id PK
        uuid journal_header_id FK
        uuid account_id FK "The accounting category"
        decimal debit "Positive amount"
        decimal credit "Positive amount"
        uuid party_id FK "Per-line precision override"
        text line_description
        uuid department_id FK
        uuid location_id FK
    }

    accounts {
        uuid id PK
        varchar account_type "asset | liability | equity | etc"
        varchar subtype "64 discrete designations"
    }

    parties {
        uuid id PK
        enum party_type "vendor | customer | both | employee | shareholder | etc"
        varchar name
    }
```

## "Syntactic Sugar" vs Core Double-Entry

To provide a modern, highly intuitive experience, the frontend exposes four distinct visual paradigms (`pay_in`, `pay_out`, `transfer`, `journal`). However, the database does not distinguish between them structurally.

The `transaction_type` enum dictates how the server interpolates the UI form into exact debit and credit lines.

### Transaction Transformation Pipeline

```mermaid
flowchart TD
    %% Define styles for clarity
    classDef uiBox fill:#f9f5fa,stroke:#c4aceb,stroke-width:2px,color:#333
    classDef dbBox fill:#eefaf0,stroke:#85db9a,stroke-width:2px,color:#333
    classDef logicBox fill:#fff3cd,stroke:#ffecb5,stroke-width:2px,color:#333

    A[User Submits Form] --> B{Transaction Type?}

    B -->|Pay In| C[Pay In Form]:::uiBox
    B -->|Pay Out| D[Pay Out Form]:::uiBox
    B -->|Transfer| E[Transfer Form]:::uiBox
    B -->|Journal| F[Journal UI]:::uiBox

    C --> C_Logic[Header: Bank Account<br>Body: Revenue Account]:::logicBox
    D --> D_Logic[Header: Bank Account<br>Body: Expense Account]:::logicBox
    E --> E_Logic[From: Asset Account<br>To: Asset Account]:::logicBox
    F --> F_Logic[Explicit Debits/Credits]:::logicBox

    C_Logic -->|Translates to| C_Line1[Line 1: Debit Bank<br>Line 2: Credit Revenue]:::dbBox
    D_Logic -->|Translates to| D_Line1[Line 1: Credit Bank<br>Line 2: Debit Expense]:::dbBox
    E_Logic -->|Translates to| E_Line1[Line 1: Credit From<br>Line 2: Debit To]:::dbBox
    F_Logic -->|Verifies Balancing| F_Line1[Line N: Direct Pass-Through]:::dbBox

    C_Line1 --> DB[(PostgreSQL `journal_lines`)]
    D_Line1 --> DB
    E_Line1 --> DB
    F_Line1 --> DB
```

### 1. Pay In (`pay_in`)

- **UI Mental Model**: "I received money inside this Bank Account from XYZ customer."
- **Data Execution**: The targeted Bank Account is assigned to `Line 0` and forcefully recorded as a **Debit** (because assets increase with Debits). All granular "Pay For" lines in the form are converted into sequential **Credit** lines assigned to the chosen accounts (e.g., Sales Revenue).

### 2. Pay Out (`pay_out`)

- **UI Mental Model**: "I spent money from this Bank Account to XYZ vendor."
- **Data Execution**: The inverse of Pay In. The Bank Account is forcefully recorded as a **Credit** (asset decreases). All granular "Pay For" lines are recorded as **Debit** lines (expenses increase via debits).

### 3. Transfer (`transfer`)

- **UI Mental Model**: "I moved money identically from Account A to Account B."
- **Data Execution**: Restricted heavily. It strictly generates 2 lines. `Account A` is Credited. `Account B` is Debited. Both accounts _must_ be classified under the `asset` or `liability` roots.

### 4. Journal (`journal`)

- **UI Mental Model**: "I am adjusting the books directly."
- **Data Execution**: No syntactic sugar is applied. The system relies entirely on the server-side validator to ensure `SUM(debits) = SUM(credits)` across the payload dimension array before appending rows to PostgreSQL.
