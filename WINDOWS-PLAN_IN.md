---
contract: PLAN_IN
version: 1
task: "Native Windows pilot: Harnessy desktop window with Claude Code and Codex subscription roles, packaged and verified without weakening API-agent sandbox boundaries."
risk: security
write_scope:
  - "WINDOWS-PLAN_IN.md"
  - "package-lock.json"
  - "packages/providers/src/path-recovery.ts"
  - "packages/providers/src/path-recovery.test.ts"
  - "packages/providers/src/env.ts"
  - "packages/providers/src/index.ts"
  - "packages/providers/src/login-terminal.ts"
  - "packages/providers/src/login-terminal.test.ts"
  - "packages/projects/src/test-helpers.ts"
  - "packages/runtime/src/state.ts"
  - "packages/runtime/src/runtime.ts"
  - "packages/runtime/src/agent-sandbox.test.ts"
  - "packages/api/src/bootstrap.ts"
  - "packages/api/src/bootstrap.test.ts"
  - "packages/api/src/build-forbidden.test.ts"
  - "packages/api/src/desktop-launcher.test.ts"
  - "packages/api/src/site-test-helpers.ts"
  - "ui/desktop/path-recovery.js"
  - "ui/desktop/after-pack.cjs"
  - "ui/desktop/electron-builder.yml"
  - "ui/desktop/package.json"
  - "ui/desktop/package-lock.json"
  - "ui/desktop/main.js"
  - "ui/desktop/engine.js"
  - "ui/desktop/build-engine.mjs"
  - "ui/desktop/updates.js"
  - "ui/deploy/forbidden-strings.txt"
  - "README.md"
  - "README.ru.md"
forbidden:
  - "Do not modify existing OMG or owner project data."
  - "Do not enable API-agent shell execution, SSH/proxy, or insecure credential storage on Windows."
  - "Do not publish a release or contact the upstream maintainer before final review."
acceptance:
  - "npm ci --ignore-scripts --no-audit --no-fund succeeds from the clean worktree."
  - "Windows PATH and Claude/Codex discovery tests pass, including paths with spaces and no Unix shell invocation."
  - "Desktop site and embedded engine prepare on Windows; a Windows package is generated and checked for forbidden data."
  - "Packaged desktop engine starts on Windows and responds to /api/status."
  - "Claude/Codex subscription roles can be reached through the Windows engine; API-agent sandbox remains unavailable on Windows."
  - "Relevant tests and an independent cross-engine review complete; changes are presented as a narrow upstream proposal."
review_base: "0f37a77c960a12ee292413d6408a62e427f0de2e"
---

## Steps

1. Restore reproducible dependency installation and capture the baseline Windows failures.
2. Add platform-aware program path and CLI discovery while preserving macOS behaviour.
3. Make desktop preparation and packaging work on Windows, with existing security guards intact.
4. Run focused tests, package smoke test, and inspect the diff for platform regressions.
5. Submit the complete diff for independent review and prepare a compact proposal for Sergey.
