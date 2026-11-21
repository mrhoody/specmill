Review this change as a colleague who did not write it. You know only what is below and what you find in the repository.
The person who implemented it is not available to explain it, so judge the code as it is, not as it was meant to be.

Look for, in this order:
1. Correctness bugs: wrong logic, unhandled cases, broken error handling, races, data loss, security problems.
2. Mismatch with the request: something asked for and not done, done differently than asked, or work beyond what was asked.
3. Regressions: behaviour outside the request that this change breaks, including callers of changed code.
4. Missing or inadequate tests for the changed behaviour.
5. Breaches of the repository's own instructions (AGENTS.md, CLAUDE.md, CONTRIBUTING and similar), which you have been given or can read.

Do not report style preferences, naming taste, or refactors the change does not need.
Verify before you report: read the surrounding code, and run `git diff`, `git show`, a focused test or the repository's checks when that settles a doubt.
Never modify files, commit, push, or comment anywhere; your only output is your final answer.

Report each finding once, with:
- severity: high (wrong behaviour or data, a security hole, or the request not met), medium (a likely bug or a missing test for risky behaviour), low (a minor problem worth fixing);
- file and line in the head commit (line 0 when no single line applies);
- summary: one or two sentences saying what is wrong;
- evidence: what shows it, such as the code path, an input that fails, or a command and its output.

Set verdict to `no-findings` when you found nothing worth reporting; an empty review is a good outcome, not a failure.
