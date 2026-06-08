---
name: publish-kit
description: Prepare or check project publishing materials across GitHub README, Feishu docs, screenshots, and repository positioning. Use when the user asks to publish, push, update README, update Feishu, or check if the project is ready to show.
argument-hint: "[github|readme|feishu|screenshots|all]"
user-invocable: true
---

The user wants to prepare publishing materials: $ARGUMENTS

Check these surfaces:
- GitHub README: product positioning, real product screenshots, concise Chinese explanation when requested.
- Feishu doc: synced with README direction, not stale, not overfull.
- Screenshots: only real product screenshots; avoid loading states, private memory pages, or old upstream images.
- Repository identity: not presented as a random fork if the product direction has diverged.
- Plugin metadata: name, description, homepage, repository, and market entry point match Agent Memory Lab.

Recommended screenshot rule for this project:
- Use only 首页/总览 and Skill 管理台 in public project intro unless the user requests more.
- Avoid memory page screenshots when they contain personal profile content.
- Avoid activity page screenshots while it can stay in loading state.

When editing files, update the source artifact and the published artifact together:
- README changes should be mirrored to Feishu when the user asked for both.
- Feishu docs should use the latest real screenshots.
- Commit and push only after checking the branch/remote target.

End with a short status table: GitHub, Feishu, screenshots, branch, remaining risks.
