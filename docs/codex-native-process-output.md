# Codex native process output cap

`command/exec/outputDelta` retains its original process ID, stdout/stderr stream,
base64 bytes and `capReached` flag. The first native cap updates the existing
`NativeProcessView.outputTruncated` field and broadcasts a state frame immediately.
An initial capped delta sends one truthful running state; repeated cap frames do
not resend the same state. Owner/generation checks still precede output handling.

The cap does not confirm exit or stop a process. A connected browser, refreshed
snapshot and log download report the same truncation flag. Downloads contain the
retained text prefix; bytes omitted by the native cap are not reconstructed.
Native stdin, resize, sandbox, cwd and exit confirmation keep their existing API.

```bash
pnpm exec vitest run packages/server/test/native-terminal-process.spec.ts --maxWorkers=1
pnpm exec tsx scripts/verify-native-process-cap.ts --binary /absolute/path/to/codex --report /private/new-cap-report.json
```

The verifier uses official Codex 0.169.0 and the production Web/HTTP/WS/SQLite
surfaces. A native Python process waits for the browser connection and stdin
before producing output beyond the unchanged default native cap. It compares the
actual capped stdout with the downloaded prefix, checks the live state and refresh,
then stops that process and awaits its original `command/exec` result. Input and
native request/process identities are recorded before forwarding. It neither
submits a model turn nor changes native prompts, tools, permissions or version.
Reports and screenshots require new private paths so prior failures remain intact.
Cleanup targets the original API process ID. A PID printed by the sandboxed
command is diagnostic output and can belong to its native PID namespace.
This scope does not establish current Provider availability, binary output
fidelity, full terminal programs or target-platform acceptance under #77/#42.
