# flowdoc

> Document workflows between packages and components as a clickable, animated diagram — driven entirely by a JSON file. Works in any repo, optimized for React Native / Expo monorepos.

Pick an action ("Invite new user", "EAS build", "Stripe Connect onboarding"…) and `flowdoc` highlights the path through your packages and annotates how data moves between them. The output is a single self-contained HTML file — no server, no CDN, drop it anywhere.

![Pluto demo — sidebar of flows, animated React Flow canvas, step-by-step detail panel](docs/preview.png)

## Why

When a system spans many packages — an Expo app, an API, a queue, a third-party like Stripe, a build pipeline — *what calls what* is the question that takes new contributors days to answer. Reading a hundred files to understand "how does an invite email actually get sent?" is a chore. `flowdoc` lets you write that path down once, in JSON, and renders it as a clickable diagram.

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

[`examples/pluto/flows.json`](examples/pluto/flows.json) documents 8 real flows on a multi-tenant booking platform (Expo app + Laravel API + MySQL + Stripe Connect + Postmark + EAS):

| Flow | What it shows |
| --- | --- |
| User login | `app → api → db → app` with the Sanctum token |
| Invite new user | API hops through the queue + Postmark and writes back the user row |
| Create a booking | DB inserts + push notifications + customer confirmation email |
| Upload a job photo | Multipart → S3 → DB metadata |
| Stripe Connect onboarding | API ↔ Stripe + webhook callback for `account.updated` |
| Customer review (token-gated) | Outbound email → tokenized public link → API submit |
| EAS build | `eas build` → native compile → App Store / Play submit |
| Web build (`expo export`) | Static bundle → nginx → API origin |

```bash
git clone https://github.com/serter2069/flowdoc.git
cd flowdoc && npm install && npm run build
node dist/cli.js build examples/pluto/flows.json -o pluto.html
open pluto.html
```

## The JSON

Two top-level arrays: `packages` (nodes) and `flows` (clickable actions, each a list of `steps` between packages).

```json
{
  "title": "My App",
  "subtitle": "Workflows between packages and components",
  "packages": [
    { "id": "app", "name": "Mobile App", "kind": "client", "icon": "📱",
      "tech": ["Expo", "React Native"], "path": "app/" },
    { "id": "api", "name": "API", "kind": "server", "icon": "🌐", "path": "api/" },
    { "id": "db", "name": "Database", "kind": "database", "icon": "🗄️" },
    { "id": "mail", "name": "Mail", "kind": "external", "icon": "✉️" }
  ],
  "flows": [
    {
      "id": "invite-user",
      "name": "Invite new user",
      "description": "Admin invites a teammate; magic-link email bootstraps the account.",
      "tags": ["onboarding"],
      "steps": [
        { "from": "app", "to": "api", "kind": "http",
          "label": "POST /invites",
          "payload": { "email": "string", "role": "worker | admin" },
          "note": "Triggered from Settings → Team → Invite." },
        { "from": "api", "to": "db", "kind": "db",
          "label": "INSERT INTO invites",
          "payload": "Invite{ token, email, role, expires_at }" },
        { "from": "api", "to": "mail", "kind": "event",
          "label": "send invitation email",
          "note": "Signed link → /accept-invite?t=..." },
        { "from": "api", "to": "app", "kind": "http",
          "label": "201 Created",
          "payload": { "inviteId": "uuid" } }
      ]
    }
  ]
}
```

### Package kinds

`client`, `server`, `database`, `external`, `build`, `queue`, `cache`, `storage`, `function`, `other`.

These are labels rendered on the node — they don't change behavior. Pick whichever fits.

### Step kinds

`http`, `rpc`, `queue`, `event`, `build`, `manual`, `db`, `other`. Optional; rendered as a chip on the step.

### Payloads

`payload` can be either a string (free-form, rendered as-is) or an object (JSON, pretty-printed).

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
