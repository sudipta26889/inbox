# MQTT agent bus

**Status:** approved, not yet implemented
**Date:** 2026-09-07

## Why

Inbox already publishes to MQTT, badly. Three live rules send to
`homeassistant/inbox/{urgent,imp-notify,remittance}`, but they do it by asking
Home Assistant to publish on their behalf — `POST /api/services/mqtt/publish`,
authenticated with a per-user long-lived HA token. So every MQTT notification
depends on Home Assistant being up, and there is no subscribe path, no retained
state, and no MQTT client in the repo at all.

Meanwhile the broker at `homeassistant.lan:1883` is busy and well-organised, and
another agent is already on it. Inbox should be a first-class participant rather
than a guest routing through HA's REST API.

## Goals

- Publish Inbox events directly to the broker, so notifications survive HA being
  down and lose a network hop.
- Let anything on the LAN — agents, dashboards, devices — learn about inbox
  state without polling and without per-subscriber configuration.
- Self-register as Home Assistant entities, so the same work yields graphable
  sensors and automation triggers.
- Keep other people's mail off the bus unless they choose otherwise.

## Non-goals

**No inbound commands.** MQTT authenticates a *connection*, not a request: one
shared credential, no per-request identity, no scopes, no per-peer audit trail.
A2A over HTTP already has all of those — per-peer tokens, scope checks, task
scoping, single-use approvals, rate limits. Accepting commands over MQTT would
mean rebuilding every one of those controls on a structurally weaker channel,
and anything on the LAN holding the one password would become every peer at
once. MQTT is the discovery plane; A2A stays the control plane. A peer that
hears an event on MQTT acts by calling A2A with its own credential.

**No approvals over MQTT.** For the same reason, and more sharply: a LAN topic
where any credential holder can publish `approved` would turn a human gate into
"anything on the network can authorise sending mail as you". Approval stays
out-of-band. Publishing *that an approval is pending* is fine and useful.

**No inbound context signals yet.** Presence data is on this broker
(`espresense/`, 258 topics of room-level BLE tracking) and could time the digest
or hold notifications. Genuinely valuable, deliberately deferred — it is a
different feature with a different trust model.

## What is on the broker

Measured 2026-09-07 by subscribing to `#` for 12 seconds: 1114 messages across
1069 topics.

| Namespace | Topics | What it is |
|---|---|---|
| `homeassistant/` | 667 | HA MQTT Discovery configs (214 sensor, 122 switch, 106 select, 80 binary_sensor, …) |
| `espresense/` | 258 | Room-level BLE presence |
| `frigate/` | 120 | NVR object detection |
| `zigbee2mqtt/` | 12 | Zigbee bridge |
| `slackagent/` | 7 | Another Dhara AI agent |
| `esphome/`, `room-assistant/`, `espnow-receiver/` | 5 | Devices |

Two facts that shaped this design:

1. `homeassistant/` is HA's **discovery prefix**. Our existing
   `homeassistant/inbox/…` topics are squatting inside it. Harmless, but wrong
   namespace — `inbox/#` is free and is where an agent's own topics belong.
2. `homeassistant/inbox/#` currently holds **nothing**, because those three
   rules publish non-retained events. Automations triggering on them work, but
   any subscriber connecting later sees no state whatsoever.

## The house convention

SlackAgent already establishes the pattern, and it is the shape HA's MQTT sensor
integration consumes:

```
slackagent/availability                            "online"          (LWT, retained)
slackagent/<entity>/state                          short scalar      (retained)
slackagent/<entity>/attributes                     JSON object       (retained)
homeassistant/sensor/slack_agent/<entity>/config   discovery         (retained)
```

Its discovery payload, verbatim:

```json
{
  "name": "Last A2A task outcome",
  "unique_id": "slack_agent_task_outcomes",
  "state_topic": "slackagent/task_outcomes/state",
  "json_attributes_topic": "slackagent/task_outcomes/attributes",
  "availability_topic": "slackagent/availability",
  "device": {
    "identifiers": ["slack_agent"],
    "name": "Slack Agent",
    "manufacturer": "Dhara AI",
    "model": "intelligence-agent"
  },
  "icon": "mdi:state-machine"
}
```

Inbox follows it. Discovery was initially scoped out as gold-plating; that was
wrong once the broker was actually inspected. The state and attributes topics
are identical either way, discovery is one extra retained JSON per entity, and
skipping it would make Inbox the only agent on this bus that does not
self-register. Following the convention is the smaller change, not the larger
one.

## Topics

```
inbox/availability                       "online" | "offline"   LWT, retained
inbox/<slug>/unread/state                512
inbox/<slug>/unread/attributes           {"total": 865}
inbox/<slug>/urgent/state                "Urgent"               last rule that fired
inbox/<slug>/urgent/attributes           {"count_today": 3, "at": "..."}
inbox/<slug>/digest/state                "ready"
inbox/<slug>/digest/attributes           {"items": 12, "at": "..."}
inbox/<slug>/approvals/state             2
inbox/<slug>/approvals/attributes        {"oldest_waiting_seconds": 42,
                                          "actions": ["create_calendar_event"]}
```

All state and attributes topics retained, so a subscriber connecting at noon
immediately knows current state instead of waiting for the next change. That is
the single biggest thing the current implementation lacks.

Discovery config per entity, retained, at
`homeassistant/sensor/inbox_<slug>/<entity>/config`, with device:

```json
{
  "identifiers": ["inbox_<slug>"],
  "name": "Inbox – <slug>",
  "manufacturer": "Dhara AI",
  "model": "email-agent"
}
```

One HA device per opted-in account. This keeps the privacy boundary visible in
Home Assistant rather than merging several people's mail into one device.

## What triggers each publish

| Entity | Published when | By |
|---|---|---|
| `availability` | On connect (`online`, retained); by the broker via LWT if the process dies (`offline`) | web |
| `unread` | Every 5 minutes, and immediately after a rule run changes counts | cron (periodic), web (on change) |
| `urgent` | A rule with an urgent or important classification executes | web |
| `digest` | The scheduled digest finishes generating | cron |
| `approvals` | An approval is created, decided, withdrawn, or expires | web |

The heartbeat interval is a floor, not the only source of truth: state topics
are retained, so a subscriber always has the last known value, and the interval
exists to bound how stale it can be. Five minutes is chosen to be cheap; nothing
depends on it being faster.

`digest/state` stays `"ready"` with the timestamp of the last successful run —
it is a retained record of the most recent digest, not a flag that resets. A
subscriber wanting freshness reads `attributes.at`.

## Architecture

Three modules, each with one job:

**`utils/mqtt/client.ts`** — owns the connection. Lazy singleton, auto-reconnect
with backoff, LWT registration, bounded outbound queue. `publish()` never throws
and never makes a caller wait on the broker.

**`utils/mqtt/topics.ts`** — pure topic and payload construction. No I/O. This is
where the privacy rules live, so they are unit-testable without a broker.

**`utils/mqtt/events.ts`** — the four publishers. Each checks opt-in before
building anything.

`utils/home-assistant.ts` changes one function: `executeMqttPublish` swaps the HA
REST call for a direct broker publish.

### Client id

Two MQTT connections sharing a client id make the broker disconnect the first —
an endless reconnect loop that presents as a broker fault. Client id must be
unique per process: `inbox-<pid>-<random>`.

There is one web replica today. If that ever changes, two replicas would also
flap the retained state topics against each other, so the periodic heartbeat
belongs in the **cron** container while event publishes stay in web. Building it
that way from the start costs nothing.

## Data model

On `EmailAccount`:

| Column | Type | Purpose |
|---|---|---|
| `mqttEnabled` | `Boolean @default(false)` | Nothing publishes without it |
| `mqttTopicSlug` | `String? @unique` | Topic label. Unique because two accounts choosing `work` would silently merge one person's events into another's |
| `mqttIncludeDetail` | `Boolean @default(false)` | Separate, explicit consent for subjects and senders |

Slug validated `^[a-z0-9][a-z0-9_-]{0,30}$` — it lands in a topic string and an
HA `unique_id`.

## Privacy

- Nothing publishes unless `mqttEnabled` is true for that account.
- No email address appears anywhere, in payloads or topics. That is why slugs
  exist rather than using the address.
- Default payloads carry counts and classifications only — no subject, sender,
  or snippet.
- `mqttIncludeDetail` adds `subject` and `from` to mail events only, per account.
- A structural test asserts the default builders cannot emit those fields, so an
  event added carelessly later fails the suite rather than quietly leaking.

This matters because the instance is not single-tenant: five users, ten email
accounts, most belonging to other people. Anything holding the one MQTT password
can read every topic on the broker.

## Failure behaviour

This path fails **soft**, which is the opposite of the approval gate and
deliberately so. The gate fails closed because it is a security control; MQTT is
a notification plane, so a broker outage must leave mail processing completely
untouched.

- `publish()` swallows and logs. It never throws into a caller, never fails a
  rule, never blocks a send.
- Bounded queue of 500 messages, dropping oldest with a warning, so an outage
  cannot grow memory without bound.
- Connection state changes log once, not per publish — otherwise an outage
  floods the log with one repeated line.

## Compatibility

The three existing rules keep their exact topics and byte-identical payloads.
Only the transport changes, from HA REST proxy to direct broker. Existing HA
automations do not notice; they stop depending on HA being up.

The new `inbox/…` bus is added alongside, not on top. Migrating those rules onto
the new namespace is a later decision for the operator, not part of this work.

## Testing

- `topics.test.ts` — payload and topic construction, slug validation, PII
  redaction, and the structural guard that default builders cannot emit
  `subject`/`from`.
- `client.test.ts` — queue bound and oldest-drop, publish-while-disconnected does
  not throw, reconnect, unique client id.
- Live verification once implemented: subscribe to `inbox/#`, observe all four
  entity types, then kill the container and confirm the broker publishes
  `inbox/availability: offline` on our behalf.

## Phases

1. **Foundation.** Env sync across `.env`, `apps/web/.env`, `.env.example`,
   `env.ts`, `turbo.json`; add the `mqtt` dependency; client and topics modules
   with unit tests. Nothing publishes yet — no behaviour change.
2. **Transport swap.** `executeMqttPublish` goes direct. Verify the three
   existing topics receive identical payloads.
3. **The bus.** Migration for the three columns, four publishers, discovery
   registration, settings UI for opt-in.
4. **Verification and docs.** Live subscribe, LWT proof, example HA automations.

## Risks

- **Broker credentials** — *resolved 2026-09-07.* `a2a_agents_mqtt_user`
  authenticates, and anonymous, wrong-password and unknown users are all
  correctly refused, so the broker is not open. Recorded here because the
  original probe failed and the design was written against a broker we could not
  yet connect to.
- **Retained topic litter.** Discovery and state topics are retained, so a slug
  that is renamed or an account that opts out leaves stale retained topics and
  orphaned HA entities behind. Opting out must publish empty retained payloads to
  the entity's config and state topics to clear them. This is easy to forget and
  the reason it is written down here.
- **Client id collision** if replicas are ever added. Covered above.
