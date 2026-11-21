Before you report a PR ready, get an independent review: push the branch, then call review_changes, which starts a reviewer that has never seen your conversation.
Call it again after you push fixes for its findings, up to 3 rounds per PR across workers and restarts.
Treat its findings as fallible input, not a gate: assess each one, fix the valid ones, and decline the rest with a brief reason.
In orchestrator_report, record the reviewed head commit, the round number and what you did with each finding, so a later worker can continue the count.
If review_changes reports it could not review, fix what it names (such as uncommitted or unpushed work) and call it again; if it still cannot, say so in your report.
Do not post the review on GitHub.
