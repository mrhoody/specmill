# Spec writing

Use this template for every spec draft. All eight sections are required. Keep the whole spec small enough for one
dsh-superagent Ticket.

```markdown
# <Short title>

## Problem

What is wrong or missing, for whom, and why it matters now. One or two short paragraphs.

## Context

What you read that shapes this spec: repository paths and the behavior you found, links to pages, issues, or code.
Be specific; a reader must be able to follow it.

## Proposal

What to change, in enough detail to build. Name the modules and interfaces. State the behavior, not the code.

## Acceptance criteria

- [ ] A testable outcome, written so a person can verify it.
- [ ] Another testable outcome.
- [ ] What remains true (no regression in ...).

## Out of scope

Work this spec deliberately leaves out, and where it would go next.

## Affected areas

Files, modules, services, or docs this is expected to touch. Say when the list is a best guess.

## Risks / open questions

- A risk and how the build should handle it.
- An open question with the decision needed, or state that none remain.

## Test plan

How the change is verified: unit, integration, manual steps in a test channel, and what evidence the PR should carry.
```

## Rules

- One spec is one Ticket. If the proposal touches several independent areas, split it and write only the first spec.
- Acceptance criteria must be checkable. Avoid "works well" or "is fast" without a threshold.
- Context is not a summary of the proposal; it is the evidence that led to it.
- Do not add an approval footer or the agent mention. `spec_handoff` adds those when it files the issue.
- Revising the draft invalidates the earlier approval. Ask again after a material change.
