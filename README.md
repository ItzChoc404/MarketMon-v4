# PokeMarket QuickSet + Marketplace Sale Automation

This version keeps the supplied Railway/deployment files unchanged and adds the complete marketplace sale workflow.

## Marketplace setup

### 1. `/forum add`
Add every Discord **Forum Channel** that contains marketplace listings.

### 2. `/forum tags`
For each marketplace Forum, configure:
- `IN STOCK` tag ID
- `SOLD OUT` tag ID

Existing listings without SOLD OUT receive IN STOCK.

New listings in configured Forums automatically receive IN STOCK.

### 3. `/tview add`
Add every channel where the separate ticket bot posts closed-ticket transcripts.

PokeBot watches all configured transcript channels.

## Listing buttons

When a new post is created in a configured marketplace Forum, PokeBot adds:

- 🟢 **BUY NOW**
- 💬 **NEGOTIATE**

### BUY NOW

When somebody presses BUY NOW, PokeBot can identify:
- the exact button interaction
- the Discord user who clicked it
- the exact Forum post/thread

It then:
1. Applies SOLD OUT.
2. Removes IN STOCK.
3. Deletes the messages inside the Forum post.
4. Leaves the Forum post/thread itself in place.
5. Posts:

`🔴 ITEM SOLD`

### NEGOTIATE

PokeBot deliberately does not change the listing status when NEGOTIATE is pressed.

The separate ticket bot can open/handle the negotiation ticket.

## Closed-ticket transcript matching

When a transcript is posted in a `/tview add` channel, PokeBot:

1. Reads transcript text, embeds and supported text/html/json/csv attachments.
2. Extracts Discord IDs when the transcript contains mentions or common user-ID/data-ID fields.
3. Also supports transcript speaker lines such as `Bob: message`.
4. Finds the card/item being discussed.
5. Searches only the Forums configured with `/forum add`.
6. Fetches active and archived Forum posts.
7. Checks the Forum post author's Discord ID.
8. Only considers listings where the Forum post author is one of the Discord users identified in the transcript.
9. Compares the card/item name and additional details such as card number, price, language, set and listing text.
10. If exactly one listing is clearly matched, marks it SOLD OUT.
11. If multiple listings are too close/ambiguous, it does NOT change anything.
12. If no confident match exists, the listing stays IN STOCK.

Example:

Bob has:
- Charizard ex 125/197 — Japanese — €40
- Charizard 006/165 — English — €25

The transcript identifies Bob as a participant and discusses Charizard ex 125/197 for €40.

PokeBot searches Bob's listings, matches the specific listing, and marks only that listing SOLD OUT.

## Manual SOLD OUT

If somebody manually applies the configured SOLD OUT tag to a marketplace post, PokeBot also performs the cleanup:
- removes IN STOCK
- deletes messages inside the post
- posts the ITEM SOLD replacement

The Forum post/thread itself is retained.

## Permissions

The bot needs enough Discord permissions to:
- View Channels
- Send Messages
- Read Message History
- Embed Links
- Use Application Commands
- Manage Threads
- Manage Messages

The bot also needs the **Message Content Intent** and **Server Members Intent** enabled in the Discord Developer Portal.

## Existing commands

- `/quickset`
- `/set continue`
- `/forum add`
- `/forum remove`
- `/forum list`
- `/forum tags`
- `/tview add`
- `/tview remove`
- `/tview list`
- `/tview log`

## Railway

The supplied Railway/deployment configuration is retained. Railway should build the TypeScript source and run the generated `dist/index.js`.

No additional npm package is required for the marketplace sale workflow.
