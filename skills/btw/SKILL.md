---
name: btw
description: Open the Side Chat (/btw) auxiliary pane or answer a quick side question without interrupting or polluting the main task.
---

# Side Chat (`/btw`) Skill

The `/btw` skill provides a lightweight, non-intrusive side conversation mechanism inspired by Claude Code's `/btw` command. It allows users to ask quick questions, inspect current state, or brainstorm tangential topics in an auxiliary panel without disturbing or polluting the main agent's working context and trajectory.

## Activation Triggers

This skill triggers when:
- The user inputs `/btw` (with or without arguments).
- The user asks to "open Side Chat", "launch side chat", "open btw panel", or similar requests to view the auxiliary side conversation.
- The user wants a quick, non-disruptive side clarification or second opinion while the main agent is working on a larger task.

## Instructions

1. **Bare Command (`/btw` or "open side chat")**:
   When the user simply types `/btw` or requests opening the side chat panel:
   - Provide a friendly, concise message explaining that the Side Chat panel is ready in the Auxiliary Pane.
   - Emit the clickable Auxiliary Pane deep link pill on its own line:
     ```markdown
     [Side Chat (/btw)](sidecar://side-chat/panel/)
     ```
   - Do not perform heavy work or alter the main task execution.

2. **Inline Side Question (`/btw <question>`)**:
   When the user provides a quick question following `/btw` (e.g., `/btw what does this regex do?`, `/btw why did you pick this library?`):
   - Answer the question **concisely and directly in 2 to 4 sentences**.
   - Always include the clickable Auxiliary Pane link pill so the user can continue their side investigation or preserve the conversation thread without cluttering the main trajectory:
     ```markdown
     [Side Chat (/btw)](sidecar://side-chat/panel/)
     ```
   - Keep the main context clean: do not start generating large artifacts or refactoring code unless explicitly directed by the user in the main conversation.

## Examples

### Example 1: Opening the Panel
**User:** `/btw`
**Agent:**
```markdown
Side Chat is available in your Auxiliary Pane for parallel discussions and quick inquiries without interrupting your current workflow.

[Side Chat (/btw)](sidecar://side-chat/panel/)
```

### Example 2: Quick Side Query
**User:** `/btw what is the difference between Array.from and spread syntax here?`
**Agent:**
```markdown
`Array.from()` creates a shallow copy from array-like or iterable objects and supports an optional mapping function, whereas the spread operator `[...]` strictly requires an iterable (implementing `Symbol.iterator`). In this context, both produce an array, but `Array.from()` also provides safety if the target is an array-like object without iterator support.

You can continue this discussion or explore more examples in the side panel:

[Side Chat (/btw)](sidecar://side-chat/panel/)
```
