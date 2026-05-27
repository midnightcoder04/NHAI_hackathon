<!--
SYNC IMPACT REPORT
==================
Version change: (unversioned template) → 1.0.0
Constitution populated from blank template — initial ratification.

Modified principles: N/A (first population)

Added sections:
  - I.   Code Quality
  - II.  Test-Driven Development (NON-NEGOTIABLE)
  - III. Testing Standards
  - IV.  User Experience Consistency
  - V.   Performance Requirements
  - Development Workflow
  - Quality Gates
  - Governance

Templates requiring updates:
  ✅ .specify/templates/plan-template.md  — Constitution Check gates align with all 5 principles
  ✅ .specify/templates/spec-template.md  — Success Criteria + Performance Goals sections align
  ✅ .specify/templates/tasks-template.md — TDD task order (write tests → fail → implement) enforced

Follow-up TODOs: None. All placeholders resolved.
-->

# NHAI Hackathon Constitution

## Core Principles

### I. Code Quality

Every line of code MUST be clean, purposeful, and maintainable. Complexity requires
explicit justification — if you cannot explain why a piece of code is complex in one
sentence, it MUST be simplified.

- Code MUST follow the project's agreed style guide and pass linting/formatting checks
  before any review.
- Functions and modules MUST have a single, clearly named responsibility. God objects
  and god functions are prohibited.
- Magic numbers and strings MUST be replaced with named constants.
- Dead code, commented-out blocks, and unused imports MUST be removed before merge.
- Abstractions MUST be earned — three concrete instances before extracting a pattern
  (YAGNI applies at all times).
- All public interfaces (functions, classes, REST endpoints) MUST be named to reveal
  intent without requiring a comment to understand.

**Rationale**: Readable code is the primary maintenance artifact. In a hackathon
context where handoffs are rapid, clarity is a force multiplier.

### II. Test-Driven Development (NON-NEGOTIABLE)

TDD MUST be practiced using the strict Red-Green-Refactor cycle for every feature,
bug fix, and behaviour change. No implementation code may be written before a failing
test exists that requires it.

- **Red**: Write a failing test that describes the desired behaviour. The test MUST
  fail for the right reason (assertion failure, not compilation/import error).
- **Green**: Write the minimum production code needed to make the test pass. No more.
- **Refactor**: Clean up both test and production code without changing observable
  behaviour. All tests MUST remain green after refactoring.
- Skipping any step in the cycle is a constitution violation and MUST be flagged in
  code review.
- Tests MUST be written by the same developer implementing the feature — not deferred
  to a QA pass.
- AI-generated code MUST be treated the same as human-written code: tests first,
  then generation, then verification that the test was already failing.

**Rationale**: TDD is the single highest-leverage technique for producing correct,
well-designed software. The discipline cannot be selectively applied — partial
adoption destroys its benefits.

### III. Testing Standards

Tests are first-class citizens of the codebase and MUST be maintained with the same
rigour as production code.

- **Unit tests**: MUST cover all business logic in isolation. External dependencies
  MUST be replaced with test doubles at the unit boundary.
- **Integration tests**: MUST cover all inter-service and inter-module contracts.
  Integration tests MUST run against real implementations (no mock databases or
  mock HTTP servers for integration-level tests).
- **Contract tests**: MUST exist for every public API endpoint and every shared
  schema. Contract tests MUST be run before any integration or E2E tests.
- **Coverage threshold**: Line coverage MUST be ≥ 80 %; branch coverage MUST be
  ≥ 70 %. Coverage checks MUST be enforced in CI — builds below threshold MUST fail.
- Test names MUST follow the pattern `given_<state>_when_<action>_then_<outcome>`
  (or equivalent BDD `Given/When/Then` style) so intent is unambiguous.
- Flaky tests MUST be fixed or deleted within one sprint of discovery — they MUST NOT
  be skipped or retried indefinitely.

**Rationale**: Without consistent testing standards the TDD discipline (Principle II)
degrades into untested code camouflaged by nominal tests.

### IV. User Experience Consistency

Every user-facing surface MUST adhere to a single, coherent design language and
interaction model. Inconsistency is a defect.

- All UI components MUST come from the project's approved component library. Custom
  one-off components require explicit approval and MUST be contributed back to the
  library.
- Terminology MUST be consistent across screens, error messages, documentation, and
  API responses. A glossary MUST be maintained and referenced before introducing
  new domain terms.
- All interactive elements MUST provide feedback within 200 ms (visual cue, loading
  state, or instant response). Silence longer than 200 ms is a UX bug.
- Error messages MUST be written in plain language, describe what went wrong, and
  offer a corrective action. Technical stack traces MUST NEVER be shown to end users.
- All user flows MUST be validated against the acceptance scenarios in `spec.md`
  before a feature is considered complete.
- Accessibility (WCAG 2.1 AA) MUST be considered during design, not retrofitted.

**Rationale**: NHAI's domain serves diverse stakeholders — engineers, administrators,
and citizens. A consistent interface reduces cognitive load and builds trust.

### V. Performance Requirements

Performance is a feature, not an afterthought. Regressions MUST be caught before
they reach production.

- API endpoints MUST respond in < 300 ms at p95 under expected load. Endpoints
  exceeding this threshold MUST be optimised or explicitly approved with a documented
  justification.
- Page / screen initial load MUST complete (Time to Interactive) in < 3 s on a
  standard broadband connection.
- Database queries MUST use appropriate indices. Queries performing full-table scans
  on large datasets (> 10 k rows) are prohibited without documented justification.
- Performance benchmarks MUST be run as part of CI for critical paths. A regression
  of > 20 % over the baseline MUST fail the build.
- Memory and CPU profiling MUST be performed before the final demo / submission.
  Results MUST be recorded in the feature's `plan.md`.

**Rationale**: Hackathon demos live or die on perceived responsiveness. Performance
standards protect the team from last-minute surprises.

## Development Workflow

- All work MUST be done on a feature branch created via `/speckit-git-feature`.
- A specification (`spec.md`) MUST exist and be approved before implementation begins.
- The implementation plan (`plan.md`) MUST pass the Constitution Check gate before
  any code is written.
- Tasks (`tasks.md`) MUST be generated from the approved plan and MUST be worked in
  dependency order.
- Every commit MUST leave the test suite fully green. Broken-window commits are
  prohibited.
- Pull requests MUST reference the relevant task ID and user story. Reviews MUST
  verify constitution compliance explicitly.

## Quality Gates

The following gates MUST pass before any branch is merged:

1. **Linting / formatting**: Zero violations.
2. **Test suite**: 100 % pass rate, coverage thresholds met (≥ 80 % line,
   ≥ 70 % branch).
3. **TDD compliance**: Reviewer MUST confirm tests were written before implementation
   (visible in commit history).
4. **Constitution Check**: Reviewer signs off that no principle has been violated or
   that any deviation is documented in `plan.md` under Complexity Tracking.
5. **Performance gate**: Benchmark CI step green; no regressions > 20 % on
   critical paths.
6. **UX acceptance**: All user story acceptance scenarios from `spec.md` verified.

## Governance

- This constitution supersedes all verbal agreements, ad-hoc conventions, and prior
  practices. When in doubt, the constitution wins.
- Any amendment requires: (1) a written proposal describing the change and rationale,
  (2) consensus from the core team, (3) a version bump per the semantic versioning
  policy below, and (4) propagation to all dependent templates.
- **Versioning policy**:
  - MAJOR — backward-incompatible change: a principle removed or fundamentally
    redefined such that existing compliant code becomes non-compliant.
  - MINOR — new principle or section added, or existing principle materially expanded.
  - PATCH — clarification, wording improvement, or non-semantic refinement.
- Compliance review MUST occur at each PR review. Non-compliance MUST be documented,
  not silently waived.
- Intentional deviations MUST be recorded in the feature's `plan.md` under
  Complexity Tracking with a one-line justification.

**Version**: 1.0.0 | **Ratified**: 2026-05-27 | **Last Amended**: 2026-05-27
