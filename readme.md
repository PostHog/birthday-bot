# PostHog's Birthday Bot

A Slack bot to collect and send birthday messages.

## Setup

```
npm install
```

```
node index.js
```

## Commands

- `/set-birthday @user DD-MM`: Set someone's birthday.
- `/set-birthday-auto firstname lastname DD-MM`: For Deel to set a birthday automatically using their first name and last name.
- `/see-birthdays`: Show all birthdays.
- `/check-birthday @user`: Check a user's birthday.
- `/post-birthday-thread @user`: Manually post a thread to the birthday channel for someone.
- `/collect-birthdays @user`: Manually collect birthday messages for someone.

To add another command, add it to the `commands.js` file and register it with [Slack](https://api.slack.com/apps/) in the "Slash Commands" section.

## Webhook API

Set birthdays automatically from an external tool (HR system, Zapier, etc.) by POSTing to the Express server. Set a `WEBHOOK_API_KEY` environment variable (locally in `.env` and on Render) and send it on each request.

```
POST /api/birthdays
Authorization: Bearer <WEBHOOK_API_KEY>     (or: X-API-Key: <WEBHOOK_API_KEY>)
Content-Type: application/json

{
  "birthday": "1990-02-11",        // required — DD-MM ("11-02") or full ISO date ("YYYY-MM-DD")
  "slack_user_id": "U123ABC",      // optional — tried first
  "email": "person@example.com",   // optional — tried second
  "first_name": "Ian",             // optional — tried last (needs last_name too)
  "last_name": "Vanagas"
}
```

Provide at least one identifier. They're resolved in priority order: **Slack user ID → email → first/last name**. Only the month and day are stored, so the year in an ISO date is ignored.

Example:

```
curl -X POST https://<your-app>.onrender.com/api/birthdays \
  -H "Authorization: Bearer $WEBHOOK_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"email": "person@example.com", "birthday": "1990-02-11"}'
```

Responses:

- `200` — `{ "ok": true, "user_id": "U123ABC", "birthday": "11-02", "matched_by": "email" }`
- `400` — invalid/missing date or no identifier provided
- `401` — missing or wrong API key
- `404` — no matching Slack user found
- `503` — `WEBHOOK_API_KEY` not configured on the server

Every authenticated request (success or failure) posts a notification to the `ADMIN_CHANNEL`, so you can see when an external tool sets — or fails to set — a birthday. Unauthenticated requests (`401`) and unconfigured-key requests (`503`) are not announced, to avoid noise from probes.

Looking up a user by email requires the `users:read.email` scope on the Slack app.

## Structure

A cron job that runs every day at 9am UK time to check:

1. If someone's birthday is 7 days away, trigger a collection of messages.
2. If someone's birthday is today, post a thread to the birthday channel.

There are also some commands that can be used to set birthdays and trigger functions manually.

## How to connect to Render database

Go to Render shell or use SSH and then go to the data directory:

```
cd /data
```

Then connect to the database:

```
sqlite3 birthdays.db
```

Then you can use the database:

```
SELECT * FROM birthdays;
```
