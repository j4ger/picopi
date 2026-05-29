---
description: Audit recent changes with the auditor subagent
argument-hint: "[focus]"
---
Review the recent changes${@:+ (focus: $@)}.

Use the `auditor` subagent on the current working tree, then give me the
prioritized list of issues (critical first) with file:line references.
