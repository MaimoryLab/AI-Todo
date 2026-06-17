<!--
Thanks for contributing! Keep PRs small and focused — one logical change per PR.
Fill in the sections below and tick every box before requesting review.
-->

## What

<!-- What does this PR do? Describe the change in plain terms. -->

## Why

<!-- Why is this change needed? Describe the user problem before the implementation. -->

## How to verify

<!-- Give the exact commands a reviewer can run to confirm this works. -->

```bash
npm install        # Node >=20
npm run pre-pr     # consistency check + build + test (~12s, mirrors CI)
```

<!--
The one integration test under test/integration.test.ts needs a live server
on :3111 and is fine to skip locally. Add any extra repro steps below.
-->

Linked issue: Fixes #

## Checklist

- [ ] Commits carry a DCO sign-off (`git commit -s`)
- [ ] `npm run pre-pr` is green locally (consistency + build + test)
- [ ] No attribution headers in the commits or PR description (no "Generated with Claude Code", no "Co-Authored-By: Claude")
- [ ] If this touches MCP tools / REST endpoints / the version number, every linked file from the matching list in AGENTS.md (Consistency Rules) was updated in lockstep
- [ ] For a substantial new feature: a reviewed feature doc exists under `docs/features/` (from `template.md`) and is linked here
- [ ] User-facing strings and public docs are in English (PRD default language is English)
- [ ] The corresponding issue is linked above (`Fixes #NNN` / `Closes #NNN`)
