---
name: sync-session
description: Extract reviewable memories, lessons, and follow-up actions from the current conversation. Use when the user asks to update memory automatically, sync this chat, summarize what should be remembered, or keep lessons up to date.
argument-hint: "[what to sync or focus on]"
user-invocable: true
---

The user wants Agent Memory Lab to sync the current session: $ARGUMENTS

Act as a careful memory curator. Do not save everything. Extract only durable, reusable items.

Produce three groups:

1. `记忆线索` — stable facts/preferences/project context that should be remembered later.
2. `可沉淀经验` — reusable process lessons, design principles, workflow rules, or mistakes to avoid.
3. `待跟进` — concrete next actions that should appear in Actions/Todo.

For each item include:
- short title
- content
- why it is durable
- privacy risk: low / medium / high
- suggested destination: memory / lesson / action / do-not-save

Then save only low-risk, clearly durable items:
- Use `memory_save` for stable memories.
- Use `memory_lesson_save` for reusable lessons.
- Use `memory_action_create` for clear next actions when available.

If the relevant MCP tool is unavailable, give the user the structured review list and say it was not saved yet. Never claim sync completed unless a save tool returned success.

Privacy rules:
- Do not save secrets, tokens, private credentials, or sensitive personal details unless the user explicitly asks.
- If the item contains personal identity, school, birthday, relationship, health, finance, or private path details, mark it medium/high risk and ask before saving.
- For public README/GitHub/Feishu materials, prefer product-level summaries over private screenshots.
