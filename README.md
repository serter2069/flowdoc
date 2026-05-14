# flowdoc

> Document your app's **user journeys** as a clickable, role-filtered diagram — driven entirely by a JSON file. Works in any repo, optimized for React Native / Expo monorepos.

Pick a role (Manager / Worker / Customer…) and a journey ("Invite + onboard a teammate", "Accept a job → mark complete", "Submit a review")  and `flowdoc` highlights the screen-to-screen path your user actually takes, annotating every tap, form, and the backend call sitting behind it. The output is a single self-contained HTML file — no server, no CDN, drop it anywhere.

![Pluto demo — role chips, role-colored journey list, screen-node canvas with action-labeled edges, step-by-step detail panel](docs/preview.png)

**Live demo:** https://serter2069.github.io/flowdoc/examples/pluto/flowdoc.html

## Why

"How does *this thing* actually work for a Manager? for a Worker? for the Customer?" is the question that takes new contributors days to answer. They squint at a flat list of routes or controllers and never see the human path through the product. `flowdoc` lets you write that path down once, in JSON, and renders it as a click-by-click diagram with role swimlanes, screens-as-nodes, and the backend-calls-that-matter pinned to the steps that trigger them.

## Install

```bash
npm install -g flowdoc
# or run on-demand:
npx flowdoc <command>
```

## Usage

```bash
# create a starter flows.json in the current directory
flowdoc init

# render flows.json → a single self-contained flowdoc.html
flowdoc build

# rebuild + browser refresh on every flows.json change
flowdoc serve
```

That's it. Open `flowdoc.html` in any browser — no server required.

## Example: Pluto

[`examples/pluto/flows.json`](examples/pluto/flows.json) documents 4 cross-role journeys on a multi-tenant booking platform (Expo app + Laravel API):

| Journey | What it traces |
| --- | --- |
| **Manager: invite + onboard a worker** | Pulse → Settings → Team → +Add user → temp_password toast → manager passes pwd out-of-band → worker signs in → My Jobs |
| **Dispatcher: create + dispatch a booking** | Dispatch → New booking (multi-step) → back to Dispatch → tap booking → Dispatch button (this is what sends the customer email) |
| **Worker: accept dispatched job → mark complete** | My Jobs (Dispatched tab) → Booking detail → status walks 'On the way' / 'On site' → Complete Booking → photo upload → Submit |
| **Customer: receive review email → submit NPS** | Worker submits → observer queues `SendReviewRequestJob` → customer email → tokenized `/reviews/{token}` web page → POST review |

```bash
git clone https://github.com/serter2069/flowdoc.git
cd flowdoc && npm install && npm run build
node dist/cli.js build examples/pluto/flows.json -o pluto.html
open pluto.html
```

## The JSON

Three top-level arrays: `roles`, `screens`, and `journeys` (each journey is a list of `steps` taken by an actor moving between screens).

```json
{
  "title": "My App",
  "subtitle": "User journeys",
  "roles": [
    { "id": "manager", "name": "Manager", "icon": "🧑‍💼", "color": "#7aa2ff" },
    { "id": "worker",  "name": "Worker",  "icon": "🛠️",  "color": "#22c55e" }
  ],
  "screens": [
    { "id": "home",    "name": "Home",     "kind": "tab",    "path": "/(tabs)/home" },
    { "id": "team",    "name": "Team",     "kind": "screen", "path": "/settings/team" },
    { "id": "team-form","name": "Add user","kind": "modal" },
    { "id": "out-of-band", "name": "Out-of-band", "kind": "out-of-band" }
  ],
  "journeys": [
    {
      "id": "invite-user",
      "name": "Manager: invite + onboard a teammate",
      "primaryActor": "manager",
      "description": "Manager creates the account; temp password goes out-of-band; new user signs in.",
      "tags": ["onboarding"],
      "steps": [
        { "actor": "manager", "on": "home", "to": "team", "action": "Tap Settings → Team", "kind": "tap" },
        { "actor": "manager", "on": "team", "to": "team-form",
          "action": "Tap '+ Add user'", "kind": "tap" },
        { "actor": "manager", "on": "team-form", "to": "team",
          "action": "Fill form, tap Save", "kind": "submit",
          "server": { "label": "POST /api/v1/users",
                      "returns": "{ meta: { temp_password: string } }" },
          "note": "Toast: 'Temp password: ABCD-1234'." },
        { "actor": "manager", "on": "team", "to": "out-of-band",
          "action": "Share the temp password (SMS / Slack / etc.)", "kind": "manual" }
      ]
    }
  ]
}
```

### Role fields
`id`, `name`, `icon?`, `color?` (hex; used to tint nodes/edges/chips), `description?`.

### Screen kinds
`screen` · `modal` · `tab` · `drawer` · `external` · `email` · `web` · `out-of-band`.
Pure labels; pick whichever fits.

### Step kinds
`tap` · `swipe` · `fill` · `submit` · `open` · `receive` · `view` · `manual` · `wait` · `decision`. Optional. Rendered as a chip on the step.

### Step shape
- `actor`: which role is performing the action
- `on`: screen they're on
- `to`: screen they end up on (omit if they stay on `on`)
- `action`: human description ("Tap the + button", "Fill name + email")
- `server`: `{label, returns?, note?}` — pinned to the step when a backend call is what makes the next screen appear

Actor changes between steps render as a "handoff" marker — useful for multi-role journeys (manager creates account → worker logs in).

## Output

`flowdoc build` writes a single HTML file:

- ~500 KB, self-contained (React + React Flow + your JSON inlined)
- No external requests at runtime
- Drop it into a static-site bucket, attach it to a release, or commit it next to your code
- Renders in any modern browser — no build step on the consumer's side

## Local development

```bash
git clone https://github.com/serter2069/flowdoc.git
cd flowdoc
npm install
npm run build              # produces dist/cli.js + dist/viewer/index.html
node dist/cli.js build examples/pluto/flows.json -o /tmp/pluto.html
npm run typecheck
```

## License

MIT
