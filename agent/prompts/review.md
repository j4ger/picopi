---
description: Review via auditor
argument-hint: "[focus]"
---
Review uncommitted changes${@:+ (git diff --cached)}. Focus: ${1:-correctness, security, maintainability}
