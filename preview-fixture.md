# Preview fixture

Throwaway file for manually testing the markdown/diagram preview in the chat webview.
Delete it when done — it is not part of the extension.

## Markdown surfaces

Headings, **bold**, `inline code`, and a list:

- first item
- second item with a [link](https://example.com)

| Column | Meaning |
| --- | --- |
| A | first |
| B | second |

```ts
const answer: number = 42;
```

## Flowchart

```mermaid
graph TD
  A[User sends a prompt] --> B{Needs a tool?}
  B -->|yes| C[Run tool]
  B -->|no| D[Answer directly]
  C --> E[Feed result back]
  E --> B
  D --> F[Done]
```

## Sequence diagram

```mermaid
sequenceDiagram
  participant U as User
  participant W as Webview
  participant H as Extension host
  U->>W: type a message
  W->>H: postMessage
  H-->>W: streamed chunks
  W-->>U: rendered answer
```

## Intentionally broken diagram

This one must stay a plain code block — no red error diagram.

```mermaid
graph TD
  A[unclosed
```
