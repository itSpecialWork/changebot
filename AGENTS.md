# Agent instructions

Read docs/PROJECT.md before planning or changing code.

Отвечай на русском пользователю

Work in small stages. Do not implement future roadmap items unless explicitly requested.

Before editing:

1. inspect the relevant files;
2. explain the proposed scope;
3. identify security-sensitive changes.

After editing:

1. run formatting;
2. run lint;
3. run typecheck;
4. run tests;
5. summarize changed files and remaining risks.

Never:

- use Float for monetary values;
- hardcode secrets;
- add real credentials;
- execute real exchanges;
- store private keys or seed phrases;
- put business logic in Telegram handlers or HTTP routes;
- silently change the database schema.

Use official current documentation for library APIs. Prefer simple code over unnecessary abstractions, but preserve domain boundaries.
