# ── Full SDLC Pipeline ───────────────────────────────────────────────
# Deterministic skill sequence using Lobster state machine.
# Each step spawns a Claude Code agent via `claude --print`.
# Approval gates pause the pipeline and return resume tokens.
#
# Usage:
#   lobster run --mode tool --file pipelines/full-sdlc.lobster --args-json '{
#     "feature": "Add audit logging",
#     "repo_dir": "/path/to/repo",
#     "notes_dir": "/path/to/notes",
#     "model": "sonnet"
#   }'
#
# Resume after approval:
#   lobster resume --token <resumeToken> --approve yes
#
# Via OpenClaw agent tool:
#   openclaw.invoke --tool lobster --action run \
#     --args-json '{"pipeline":"pipelines/full-sdlc.lobster","argsJson":"{...}"}'
# ─────────────────────────────────────────────────────────────────────

name: full-sdlc
description: "Full SDLC pipeline: requirements → tickets → implementation → review chain"

args:
  feature:
    description: "Feature description or user story"
  repo_dir:
    description: "Target repository directory"
  notes_dir:
    description: "Notes/docs output directory"
  model:
    default: sonnet
    description: "Claude model (opus, sonnet, haiku)"
  skill_dir:
    default: "~/.claude/skills"
    description: "Path to Claude Code skill definitions"
  max_review_instances:
    default: "3"
    description: "Number of parallel review instances per gate"

# Unset CLAUDECODE to allow spawning Claude Code agents from any context
# (including inside an existing Claude Code session or OpenClaw gateway).
# Unset ANTHROPIC_API_KEY so Claude Code uses OAuth subscription auth
# instead of an invalid or missing API key.
env:
  CLAUDECODE: ""
  ANTHROPIC_API_KEY: ""

# ── Step 1: Project Init (TRD → HLD → DLD) ──────────────────────────
steps:
  - id: project-init
    run: >
      claude --print
      --model ${model}
      --permission-mode bypassPermissions
      --output-format json
      --max-turns 100
      "$(cat ${skill_dir}/project-init/SKILL.md)

      ## Feature
      ${feature}

      ## Output Directory
      Write all documents to: ${notes_dir}
      "

  # ── Step 2: Assign Tickets ──────────────────────────────────────────
  - id: assign-tickets
    run: >
      claude --print
      --model opus
      --permission-mode bypassPermissions
      --output-format json
      --max-turns 80
      "$(cat ${skill_dir}/assign-tickets/SKILL.md)

      ## TRD Location
      $project-init.stdout

      ## Notes Directory
      ${notes_dir}
      "
    stdin: $project-init.json

  # ── Step 3: Approve ticket breakdown before implementation ──────────
  - id: approve-tickets
    approval:
      prompt: "Review ticket breakdown. Approve to begin implementation?"
    stdin: $assign-tickets.json

  # ── Step 4: Implement Tickets (TDD) ────────────────────────────────
  # Sequential implementation — each instance gets ticket context from
  # assign-tickets output. For parallel, use multiple steps or loop.
  - id: implement-tickets
    run: >
      claude --print
      --model ${model}
      --permission-mode bypassPermissions
      --output-format json
      --max-turns 200
      "$(cat ${skill_dir}/implement-ticket/SKILL.md)

      ## Tickets
      $assign-tickets.stdout

      ## Repository
      ${repo_dir}

      ## Notes
      ${notes_dir}

      Implement ALL tickets sequentially using strict TDD (Red-Green-Refactor).
      For each ticket: write failing test first, then minimal code to pass, then refactor.
      "
    stdin: $assign-tickets.json
    when: $approve-tickets.approved

  # ── Step 5: QA Review (6 reviewers batched) ────────────────────────
  - id: qa-review
    run: >
      claude --print
      --model ${model}
      --permission-mode bypassPermissions
      --output-format json
      --max-turns 50
      "$(cat ${skill_dir}/qa-review/SKILL.md)

      ## Review Target
      You are running 6 independent QA reviews: QA-1 through QA-6.

      ## Repository
      ${repo_dir}

      ## Notes
      ${notes_dir}

      ## Implementation Output
      $implement-tickets.stdout

      For EACH of QA-1 through QA-6, perform an independent review.
      Each reviewer MUST independently assess:
      1. Functional correctness
      2. Test quality and coverage
      3. Code quality and standards compliance
      4. Integration safety
      5. Documentation

      Output format for EACH reviewer:
      ## QA-<N> Review
      **Verdict**: APPROVE | REQUEST CHANGES
      ### Findings
      - [BLOCKING/SUGGESTION] file:line — description
      ### Positive Notes

      ## Final Tally
      Report: X/6 APPROVED. ALL 6 must approve to pass.
      "
    stdin: $implement-tickets.json

  # ── Step 6: Type Strictness Review (6 reviewers batched) ───────────
  - id: type-review
    run: >
      claude --print
      --model ${model}
      --permission-mode bypassPermissions
      --output-format json
      --max-turns 50
      "You are running 6 independent Type Strictness reviews: TS-1 through TS-6.

      ## TypeScript Coding Standards
      - Always use explicit type annotations on all function parameters, return types, and variable declarations
      - Never use any — use unknown, generics, or proper type narrowing
      - Default to readonly on all properties, parameters, arrays, and tuples
      - Use branded/tagged types for domain concepts
      - Prefer union-of-literals over enums or plain primitives
      - Use as const for literal values
      - Use DeepReadonly<T> for complex nested objects
      - Generic type parameters must use extends constraints

      ## Repository
      ${repo_dir}

      ## Notes
      ${notes_dir}

      For EACH of TS-1 through TS-6, perform an independent type strictness review.
      Check every changed file against ALL checklist items.
      Any single BLOCKING finding means REQUEST CHANGES.

      Output format for EACH reviewer:
      ## TS-<N> Review
      **Verdict**: APPROVE | REQUEST CHANGES
      ### Checklist (PASS | FAIL for each)
      ### Issues Found
      - [BLOCKING/SUGGESTION] file:line — description

      ## Final Tally
      Report: X/6 APPROVED. ALL 6 must approve to pass.
      "
    stdin: $qa-review.json

  # ── Step 7: Security Review (6 reviewers batched) ──────────────────
  - id: security-review
    run: >
      claude --print
      --model ${model}
      --permission-mode bypassPermissions
      --output-format json
      --max-turns 50
      "$(cat ${skill_dir}/security-review/SKILL.md)

      ## Review Target
      You are running 6 independent Security reviews: SEC-1 through SEC-6.

      ## Repository
      ${repo_dir}

      ## Notes
      ${notes_dir}

      ## Prior Reviews
      QA: $qa-review.stdout
      Type: $type-review.stdout

      For EACH of SEC-1 through SEC-6, perform an independent security review.
      Check ALL vulnerability categories (OWASP Top 10, CWE taxonomy).
      NEVER approve with unresolved findings at ANY severity level.

      Output format for EACH reviewer:
      ## SEC-<N> Review
      **Verdict**: APPROVE | REQUEST CHANGES
      **Findings**: N critical, N high, N medium, N low
      ### Issues
      - [CRITICAL/HIGH/MEDIUM/LOW] CWE-ID — file:line — description

      ## Final Tally
      Report: X/6 APPROVED. ALL 6 must approve to pass.
      "
    stdin: $type-review.json

  # ── Step 8: Security Scan (automated) ──────────────────────────────
  - id: security-scan
    run: >
      claude --print
      --model ${model}
      --permission-mode bypassPermissions
      --output-format json
      --max-turns 30
      "$(cat ${skill_dir}/security-scan/SKILL.md 2>/dev/null || echo 'Run automated security scan against the repository.')

      ## Repository
      ${repo_dir}

      ## Notes
      ${notes_dir}

      Scan all changed files for vulnerabilities using OWASP, CWE, and PortSwigger references.
      Output structured findings as JSON.
      "

  # ── Step 9: Staff Review — human approval gate ─────────────────────
  - id: staff-review
    run: >
      claude --print
      --model opus
      --permission-mode bypassPermissions
      --output-format json
      --max-turns 80
      "$(cat ${skill_dir}/staff-review/SKILL.md)

      ## Repository
      ${repo_dir}

      ## Notes
      ${notes_dir}

      ## Review Chain Results
      QA Review: $qa-review.stdout
      Type Review: $type-review.stdout
      Security Review: $security-review.stdout
      Security Scan: $security-scan.stdout

      Assess architecture, standards compliance, completeness, test quality, and integration risk.
      Produce a final technical verdict.
      "
    stdin: $security-scan.json

  - id: approve-staff
    approval:
      prompt: "Staff Engineer review complete. Approve to proceed to VP review?"
    stdin: $staff-review.json

  # ── Step 10: VP Review — human approval gate ───────────────────────
  - id: vp-review
    run: >
      claude --print
      --model opus
      --permission-mode bypassPermissions
      --output-format json
      --max-turns 50
      "$(cat ${skill_dir}/vp-review/SKILL.md)

      ## Repository
      ${repo_dir}

      ## Notes
      ${notes_dir}

      ## Staff Review
      $staff-review.stdout

      ## Full Review Chain
      QA: $qa-review.stdout
      Type: $type-review.stdout
      Security: $security-review.stdout

      Assess feature completeness against TRD. Produce risk assessment and
      executive summary for Christopher (final approver).
      "
    stdin: $staff-review.json
    when: $approve-staff.approved

  - id: approve-vp
    approval:
      prompt: "VP review complete. Approve for final merge?"
    stdin: $vp-review.json

  # ── Step 11: Final Summary ─────────────────────────────────────────
  - id: summary
    run: >
      claude --print
      --model ${model}
      --permission-mode bypassPermissions
      --output-format json
      "Produce a final pipeline summary as JSON:

      ## Feature
      ${feature}

      ## Pipeline Results
      - Project Init: $project-init.stdout
      - Tickets: $assign-tickets.stdout
      - Implementation: $implement-tickets.stdout
      - QA Review: $qa-review.stdout
      - Type Review: $type-review.stdout
      - Security Review: $security-review.stdout
      - Security Scan: $security-scan.stdout
      - Staff Review: $staff-review.stdout
      - VP Review: $vp-review.stdout

      Output JSON with: feature, status (approved/rejected), review_chain summary,
      risk_assessment, and recommendation.
      "
    when: $approve-vp.approved
