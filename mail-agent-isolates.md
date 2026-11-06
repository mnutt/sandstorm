# Mail Agent Isolate Sketch

This is a plausible object-capability layout for a mail triage agent built from
several Sandstorm isolate grains. It intentionally hand-waves most application
logic and focuses on how the isolates hold authority, expose capabilities, and
call each other.

The important runtime assumption from the current isolate design is that these
workers are normal Sandstorm grains. They use Worker-style `fetch(request, env,
ctx)`, explicit bindings, isolate storage, app-defined `RpcTarget`
capabilities, and Powerbox-saved capability tokens. They do not get ambient
network or ambient cross-grain service names.

## Workers

### `llm`

Purpose:

- Own the authority to call OpenAI.
- Expose a reusable conversational LLM capability to other grains.
- Hide provider credentials, request formatting, retries, and streaming details
  behind a small capability surface.

Authority:

- During setup, the owner grants this grain an API/network capability for
  `https://api.openai.com`, probably as an `ApiSession` selected through
  Powerbox.
- The isolate saves that grant in its own storage, for example under
  `openai-api-token`.
- On each request it restores the saved capability and calls it with
  `ClaimedCapability.fetch()`.

Exported capability:

```ts
interface ConversationalLlm {
  streamConversation(request: ConversationRequest): ConversationStream;
  completeJson(request: ConversationRequest): Promise<JsonValue>;
}

interface ConversationStream {
  next(): Promise<ConversationChunk | null>;
  cancel(): Promise<void>;
}
```

In current isolate terms, `ConversationalLlm` is an app-defined persistent
`RpcTarget` registered with a stable ID such as `conversational-llm-v1`. The
grain can offer this capability through Powerbox. Consumer grains save the
returned token and later restore it from their own storage.

`streamConversation()` could be implemented as a returned child `RpcTarget`
whose `next()` method advances the model stream. If a future isolate helper has
a better native byte/event stream abstraction for object capabilities, this
surface can be replaced by that without changing the authority graph.

Durable state:

- Saved OpenAI `ApiSession` token.
- Provider/model configuration.
- Optional usage counters and rate-limit state.
- No mail contents unless explicit logging/debugging is enabled.

### `mail-classifier`

Purpose:

- Subscribe to a mail feed.
- Receive `MailEvent` values shaped like
  `/home/michael/p/personal/mail-bridge/src/capnp/mail-feed.capnp`.
- Ask the LLM whether a message is important.
- For important messages, generate a concise summary and deliver a `Message` to
  the messages worker.
- Maintain durable per-sender instructions.

Authority:

- A saved `MailFeed` capability from the mail bridge.
- A saved `ConversationalLlm` capability from the `llm` isolate.
- A saved message-sink capability from the `messages` isolate.

Exported capability:

```ts
interface MailEventPort {
  deliver(event: MailEvent): Promise<void>;
}
```

The classifier registers a persistent object capability with a stable ID such
as `mail-event-port-v1`. During setup it gives that persistent capability to
the mail feed:

```ts
const receiver = await api.persistentCapability(new MailClassifierPort(), {
  id: "mail-event-port-v1",
  storageKey: "mail-event-port-token",
  label: "Mail classifier receiver",
});

const mailFeed = await api.powerbox().restoreSaved({ storageKey: "mail-feed-token" });
await mailFeed.asRpc().addReceiver(receiver, {
  filter: {
    toContains: "",
    fromContains: "",
    subjectContains: "",
    includeAttachments: false,
  },
  start: "fromNow",
  payload: "metadataAndText",
});
```

The actual Cap'n Proto `MailFeed.addReceiver()` returns a subscription handle.
The classifier should save that handle if the bridge exposes it as persistent,
or otherwise record enough local subscription state to avoid creating duplicate
subscriptions during setup.

Durable state:

- `mail-feed-token`: saved mail feed capability.
- `llm-token`: saved `ConversationalLlm` capability.
- `messages-token`: saved message-sink capability.
- `mail-event-port-token`: saved self capability, if useful for re-offer or
  self-restoration.
- `sender-instructions`: a map keyed by normalized sender address or domain.
- `processed-dedupe-keys`: a bounded set keyed by `MailEvent.metadata.dedupeKey`
  or `messageKey`.
- Optional subscription handle/token.

Per-sender instruction shape:

```ts
type SenderInstruction = {
  sender: string;
  policy: "always-important" | "never-important" | "llm-decides";
  notes: string;
  updatedAt: string;
};
```

Classification flow:

1. `MailFeed` calls `MailEventPort.deliver(event)`.
2. Classifier checks `dedupeKey` and stores an in-progress marker.
3. Classifier loads sender instructions for `from[].address`, domain, and any
   global defaults.
4. Classifier sends the metadata and plain text body to `llm.streamConversation`
   or `llm.completeJson`.
5. LLM returns a structured decision such as:

```json
{
  "important": true,
  "confidence": 0.86,
  "summary": "Flight schedule changed; action needed by Friday.",
  "reason": "Contains deadline and travel impact.",
  "labels": ["travel", "deadline"]
}
```

6. If not important, classifier records the processed dedupe key and stops.
7. If important, classifier creates a `Message` and calls the messages worker.
8. Classifier marks the dedupe key complete.

Proposed message shape:

```ts
type Message = {
  id: string;
  source: "mail";
  title: string;
  body: string;
  priority: "normal" | "high";
  createdAt: string;
  dedupeKey: string;
  actionUrl?: string;
  sourceRef: {
    messageKey: string;
    messageId: string;
    from: Array<{ name: string; address: string }>;
    receivedAt: string;
  };
  labels: string[];
};
```

`actionUrl` can be omitted initially. Later it could point at a route-backed
WebSession capability for viewing the source email, if the mail bridge or
classifier exposes one.

### `messages`

Purpose:

- Maintain a durable inbox of generated messages.
- Provide a narrow capability for adding messages.
- Notify mobile devices when a new message arrives.
- Provide a UI/API for reading, acknowledging, archiving, or deleting messages.

Authority:

- A saved push-notification capability from the `mobile-notifications` isolate.
- Optionally user-granted capabilities to source systems if messages need
  deep links or actions.

Exported capabilities:

```ts
interface MessageSink {
  addMessage(message: Message): Promise<AddMessageResult>;
}

interface MessageInbox {
  listMessages(query: MessageQuery): Promise<Message[]>;
  markRead(id: string): Promise<void>;
  archive(id: string): Promise<void>;
}
```

`MessageSink` should be a persistent app-defined object capability with a
stable ID such as `message-sink-v1`. The messages isolate offers it to the
classifier through Powerbox; the classifier saves the returned token.

Durable state:

- `messages`: an indexed collection keyed by `Message.id`.
- `dedupe`: a map from source/dedupe key to message ID.
- `push-token`: saved `PushNotification` capability.
- Read/archive state.

Add-message flow:

1. `mail-classifier` calls `MessageSink.addMessage(message)`.
2. `messages` validates the message boundary and dedupes by
   `source + dedupeKey`.
3. `messages` persists the inbox item before notifying.
4. `messages` restores the saved push capability and calls
   `sendPushNotification()`.
5. If push delivery fails, the inbox item remains durable and a retry marker can
   be stored separately.

The messages isolate owns notification fan-out policy. The classifier decides
whether something is important; the messages isolate decides whether that
important item should trigger mobile push immediately, be batched, or be
suppressed because the user already read it.

### `mobile-notifications`

Purpose:

- Own APNs/FCM HTTP authority and provider credentials.
- Pair with a mobile app.
- Expose a small push capability to trusted grains.

Authority:

- API/network capabilities for Apple and Google push endpoints, granted through
  Powerbox or a future explicit outbound HTTP capability provider:
  `https://api.push.apple.com` and `https://fcm.googleapis.com`.
- Provider credentials or signing keys stored only in this grain.

Exported capability:

```ts
interface PushNotification {
  sendPushNotification(notification: PushRequest): Promise<PushResult>;
}
```

Possible request shape:

```ts
type PushRequest = {
  id: string;
  title: string;
  body: string;
  urgency: "normal" | "high";
  collapseKey?: string;
  deepLink?: string;
};
```

Durable state:

- Saved APNs/FCM API capability tokens.
- APNs key ID/team ID/topic or FCM service-account material.
- Device registrations from the paired mobile app.
- Per-device platform, token, last-seen time, enabled/disabled state.
- Delivery attempts and backoff state.

Pairing flow:

1. The mobile app opens a pairing flow against the `mobile-notifications` grain.
2. The grain creates a short-lived pairing code or webkey.
3. The mobile app proves possession of the code and uploads its APNs/FCM device
   token plus platform metadata.
4. The grain stores the device registration.
5. The grain offers `PushNotification` through Powerbox to the `messages`
   isolate, or the owner selects it from the messages isolate setup UI.

Send flow:

1. `messages` calls `PushNotification.sendPushNotification()`.
2. `mobile-notifications` validates size, urgency, and allowed deep-link shape.
3. It maps the request into APNs and/or FCM provider payloads.
4. It restores the appropriate saved API capability and calls
   `ClaimedCapability.fetch()` against the provider endpoint.
5. It records success/failure per device and returns a compact result.

## End-To-End Setup

One plausible initial setup order:

1. Owner creates/configures `mobile-notifications`.
2. Owner grants APNs/FCM outbound API capabilities to `mobile-notifications`.
3. Owner pairs the mobile app.
4. Owner creates `messages`.
5. `mobile-notifications` offers `PushNotification`; `messages` saves it.
6. Owner creates `llm`.
7. Owner grants `llm` an API capability for `https://api.openai.com`.
8. `llm` offers `ConversationalLlm`.
9. Owner creates `mail-classifier`.
10. Owner grants `mail-classifier` the `MailFeed`, `ConversationalLlm`, and
    `MessageSink` capabilities.
11. `mail-classifier` registers its persistent `MailEventPort` with
    `MailFeed.addReceiver()`.

After setup, all runtime calls are capability calls between grains. No isolate
needs to discover another by name.

## Runtime Call Graph

```text
mail bridge
  -> MailEventPort.deliver(event)
     mail-classifier
       -> ConversationalLlm.completeJson(...)
          llm
            -> OpenAI ApiSession.fetch(...)
       -> MessageSink.addMessage(message)
          messages
            -> PushNotification.sendPushNotification(...)
               mobile-notifications
                 -> APNs/FCM ApiSession.fetch(...)
```

## Capability Inventory

| Holder | Capability | Provider | Stored where |
| --- | --- | --- | --- |
| `llm` | OpenAI `ApiSession` | outbound/API provider | `llm` storage |
| `mail-classifier` | `MailFeed` | mail bridge | classifier storage |
| `mail-classifier` | `ConversationalLlm` | `llm` | classifier storage |
| `mail-classifier` | `MessageSink` | `messages` | classifier storage |
| mail bridge | `MailEventPort` | `mail-classifier` | mail bridge/subscription |
| `messages` | `PushNotification` | `mobile-notifications` | messages storage |
| `mobile-notifications` | APNs/FCM `ApiSession` | outbound/API provider | mobile storage |

## Notes And Open Edges

- The current isolate plan removed ambient `publicFetch`, so outbound HTTP is
  modeled as explicit Powerbox authority. If Sandstorm later grows a narrower
  first-class outbound HTTP grant, the OpenAI/APNs/FCM capabilities can move to
  that without changing the higher-level worker graph.
- Streaming over app-defined object capabilities is sketched as a returned
  child `RpcTarget` with `next()` and `cancel()`. This is enough to explain the
  authority flow, but a real implementation should use the most natural stream
  primitive available in the released isolate helper API.
- The mail classifier should avoid storing full message bodies after
  classification unless the product explicitly needs an audit/debug log.
- Deduplication should happen in both `mail-classifier` and `messages`.
  Classifier dedupe avoids repeated LLM calls; messages dedupe protects the
  durable inbox boundary.
- The push worker should not receive raw email bodies or LLM prompts. It only
  needs notification text and a deep link or message ID.
