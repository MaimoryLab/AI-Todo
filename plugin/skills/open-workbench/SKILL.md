---
name: open-workbench
description: Open the local Agent Memory Lab viewer or tell the user the exact local URL. Use when the user asks to open memory, dashboard, viewer, workbench, Agent Memory Lab, or wants to inspect memories, sessions, skills, actions, or activity.
argument-hint: "[dashboard|memories|sessions|skills|actions|activity]"
user-invocable: true
---

The user wants to open Agent Memory Lab: $ARGUMENTS

Choose the target tab from `$ARGUMENTS`:
- `dashboard`, `home`, `overview`, empty -> `dashboard`
- `memory`, `memories` -> `memories`
- `session`, `sessions`, `timeline` -> `sessions`
- `skill`, `skills`, `plugin` -> `lessons`
- `todo`, `action`, `actions` -> `actions`
- `activity` -> `activity`

Open or share this URL:

```text
http://localhost:3113/#<tab>
```

If browser control is available, open the URL directly. If not, tell the user the exact URL and say to start the service first if it is unreachable:

```bash
agentmemory viewer
```

Do not expose graph/audit/replay/profile as primary destinations; those are implementation/debug surfaces in this product direction.
