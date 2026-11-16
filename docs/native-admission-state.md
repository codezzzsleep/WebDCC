# Native admission responses and later outcomes

A successful `send` or `steer` response confirms submission, not the final
outcome of its input. Native events can arrive before that response. For example,
an autonomous native turn can begin while the preceding turn still lacks its
terminal frame; the preceding input must remain `uncertain` even if its original
submission subsequently returns successfully.

`CommandJournal.acceptInput` advances only an input still in `dispatching`.
When a public command row exists, its state, session and admission turn must
also match. Both rows advance in one SQLite immediate transaction, retaining
their receipt, input bytes, attachment references, ordinal and native request
identity. An internal admission without a public command row remains supported.

An already uncertain, completed, failed or cancelled admission is preserved.
This response does not resolve uncertainty, retry input or replace native
reconciliation. Ordinary `send` and `steer` use the same confirmation boundary.

Issue #251 covers this behavior under #45/#46. The focused regression uses
controlled adapters for Codex, Claude Code and DSH, plus local HTTP and SQLite,
including independent connections, write failure and database reopen. It does
not prove current provider availability or target-platform native behavior.
