# Scenario author — checklist

You are about to write `scenarioTrees[]` for a flows.json. Before you write
a single step, finish this checklist for the page/screen you're writing
about. **Skipping the checklist always leads to hallucinated steps that
fail `flowdoc validate`.**

---

## 1. Open the actual file

For every state your scenario touches:

- **Web page (Laravel + Inertia)**: open the matching React file. For Pluto
  that's `api/resources/js/pages/<route>/*.tsx`. For other Laravel projects
  look under `resources/js/pages/` or `resources/js/Pages/`.
- **RN screen**: open `app/src/screens/<Name>Screen.tsx`.
- **Expo Router route**: open the matching `app/<route>/index.tsx`.

Do **not** infer behavior from the path name alone (`/booking` does **not**
mean there is a time-slot picker). Read the JSX, see the actual fields and
buttons.

## 2. List the real form fields and buttons

For each state, write down (in your head or in a scratchpad):

- Form fields: every `<TextInput>`, `<input>`, `<select>`, `<Picker>`,
  `<Checkbox>`, etc. Note required vs optional.
- Buttons / press handlers: every `<Button onPress=...>`, `<Pressable>`,
  `<TouchableOpacity>`, `<button onClick=...>`. Note what each one **does**
  — not what it could plausibly do.
- Wizard steps: search for `currentStep`, `step ===`, `wizard`, `funnel`.
  If the page is a multi-step flow, list the steps in order.

Then look at the corresponding state in `flows.json`:

- `state.actions[]` — what the scanner already extracted (API endpoints).
- `state.controls[]` — what the scanner extracted as form controls (if any).
- `state.params[]` — route/query params the state takes.

**If your step references a button or field that's not in any of the
above, it's a hallucination. Stop.**

## 3. Map step text → real action

Every step that does something (not just observes) must have:

- A verb that matches the kind of `state.actions[]` available:
  `pick/select/choose` → state has `select:*` or `edit:*` action
  `upload/attach` → state has `upload:*` action
  `submit/save/create` → state has `submit:*` or `add:*` action
  `delete/cancel/remove` → state has `delete:*` action
  `approve/reject` → state has `approve:*` or `reject:*` action

- A noun that matches the `target` of the action OR its `comment` field
  (the comment usually contains the API URL — match against that).

Example, good:
```
state /booking has actions:
  submit:post   (POST /booking)
  upload:upload-photo
  submit:s      (POST /bookings)

Step:  "Client submits the booking"
Match: action submit:s OR submit:post — fine.
```

Example, bad:
```
state /booking has actions: (as above)

Step:  "Client picks a time slot"
Match: no select:* action on /booking. There's no time-slot picker in the
       code. HALLUCINATION — remove the step or move it to a state that
       actually has a time-slot UI (manager-side scheduling, not /booking).
```

## 4. Run `flowdoc validate` before you commit

```bash
flowdoc validate flows.json
```

Fix every warning (or annotate why it's a false positive). If you push
trees with `flowdoc validate` warnings, the CI will reject them
(`flowdoc validate --fail-on-warning`).

## 5. Common pitfalls in this codebase

- **`/booking` is a 4-step wizard** (Product → Contact+Address → Photos →
  Review). There is no date or time-slot picker — managers schedule the
  appointment _after_ the booking is created.

- **Notifications and webhooks have no `actions[]`** because they aren't
  user-visible UI. `nf-*`, `wh-*`, `job-*` states are leaf steps in a
  scenario — describe them as side-effects (e.g. "BookingCreatedNotification
  dispatched"), not as something the user does.

- **RN screens may have empty `actions[]`** because the scanner currently
  doesn't extract `onPress` handlers from `.tsx`. If you genuinely know an
  action exists on a screen but it's not in the JSON, **add it to the
  scanner first**, then write the scenario. Don't paper over it by writing
  a step that fails validate.

- **Action targets often look like URL slugs**. POST `/bookings` → target
  `s` (last URL segment). POST `/booking` → target `post`. POST
  `/bookings/upload-photo` → target `upload-photo`. The scanner is dumb on
  purpose; do `flowdoc validate` to see what targets really exist.

## 6. If a needed UI affordance genuinely doesn't exist yet

You can mark a step as an **assumption**:

```json
{
  "step": "Client picks a time slot",
  "stateRef": 3,
  "expect": "Slot is selected",
  "assumption": "UI doesn't exist yet — design says we want this feature in v2"
}
```

`flowdoc validate` still warns, but with `assumption: true` it's surfaced
as a planned-feature gap rather than a bug. Use sparingly.
