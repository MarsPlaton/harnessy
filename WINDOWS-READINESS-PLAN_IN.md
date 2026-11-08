---
contract: PLAN_IN
version: 1
task: "Finish the first Windows Claude/Codex subscription pilot as a reliable desktop workflow before any migration of the owner's orchestration system."
risk: security
write_scope:
  - "WINDOWS-READINESS-PLAN_IN.md"
  - "packages/projects/src/attachments.ts"
  - "packages/runtime/src/agent-sandbox.test.ts"
  - "packages/api/src/attachments.test.ts"
  - "packages/projects/src/test-helpers.ts"
  - "packages/api/src/alpha-signup.test.ts"
  - "packages/api/src/catalog-startup.test.ts"
  - "packages/api/src/tasks.test.ts"
  - "packages/api/src/desktop-launcher.test.ts"
  - "packages/api/src/build-forbidden.test.ts"
  - "packages/api/src/site-test-helpers.ts"
  - "ui/deploy/release.js"
  - "ui/desktop/package.json"
  - "ui/desktop/after-pack.cjs"
  - ".github/workflows/windows-pilot.yml"
  - "README.md"
  - "README.ru.md"
forbidden:
  - "Do not migrate or modify the owner's existing four-role orchestration projects."
  - "Do not enable Autopilot, API-agent shell, SSH/proxy, or subscription-token handling beyond the existing pilot."
  - "Do not publish a release or mark the draft PR ready before the Windows acceptance gates pass."
acceptance:
  - "Image upload and retrieval work on Windows without weakening project and file identity checks; focused attachment tests pass."
  - "The Windows test failures and hang are classified with reproducible evidence, and a bounded Windows pilot test command is available for CI."
  - "Packaged Windows desktop starts, opens a project, and the Claude/Codex role workflow is exercised with isolated data."
  - "Build and targeted Windows CI checks pass; an independent cross-engine review covers the new diff."
  - "The PR and HANDOFF state remaining macOS, full-suite, and provider-policy constraints accurately."
review_base: "0f37a77c960a12ee292413d6408a62e427f0de2e"
---

## Steps

1. Capture the Windows full-suite baseline and group failures by root cause and pilot relevance.
2. Repair image uploads with a Windows-compatible durable write and verify attachment invariants.
3. Establish a bounded Windows pilot test command and CI workflow for the features in scope.
4. Verify a packaged desktop workflow and independently review the cumulative PR diff.
5. Update the draft PR and the project HANDOFF; keep migration deferred until the owner asks for it.
