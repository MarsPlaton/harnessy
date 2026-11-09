---
contract: PLAN_IN
version: 1
task: "Make Harnessy's complete test suite finish successfully on Windows and verify the packaged desktop workflow without using the owner's Claude subscription through Harnessy before provider-policy approval."
risk: security
write_scope:
  - "WINDOWS-FULL-SUITE-PLAN_IN.md"
  - "packages/**"
  - "ui/**"
  - ".github/workflows/**"
  - "README.md"
  - "README.ru.md"
forbidden:
  - "Do not migrate or modify the owner's existing OMG, AgentTeam, or other production projects."
  - "Do not call Claude/Codex through Harnessy with the owner's subscription until the provider-policy question is resolved."
  - "Do not bypass, weaken, or silently skip security assertions to make the suite green."
  - "Do not publish a release or mark the PR ready while acceptance or policy gates are open."
acceptance:
  - "Every test file finishes under the standard npm test command on Windows with zero failures and no hangs; platform-only skips are documented and meaningful."
  - "Windows CI build and the complete suite are green, and macOS CI remains green."
  - "A packaged Windows desktop is smoke-tested with isolated project data, with live subscription use still paused."
  - "Independent Claude review of the complete diff has no unresolved Critical or Important findings."
  - "The draft PR and cross-project HANDOFF state the policy constraint and actual readiness accurately."
review_base: "0f37a77c960a12ee292413d6408a62e427f0de2e"
---

## Steps

1. Reproduce and group the 93 failed and four timed-out test files by root cause. Distinguish Windows product defects from nonportable test fixtures and the audit runner's credential isolation.
2. Repair common fixture and runner problems first: CLI processes, Electron launch, symlink test setup, teardown, and path assertions. Verify each group with targeted tests before broadening.
3. Repair actual Windows product defects revealed by the suite, preserving file identity, path boundaries, and other security invariants. Add focused regressions where behavior changes.
4. Run `npm test` to completion on Windows, then test the packaged app with isolated data and check the full Windows/macOS CI matrix.
5. Obtain independent Claude review, address findings, update the draft PR and HANDOFF, and report the remaining external provider-policy gate.
