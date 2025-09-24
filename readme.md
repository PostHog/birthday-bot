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
- `/post-birthday-thread @user`: Manually post a thread to the birthday channel for someone.
- `/collect-birthdays @user`: Manually collect birthday messages for someone.

To add another command, add it to the `commands.js` file and register it with [Slack](https://api.slack.com/apps/) in the "Slash Commands" section.

## Structure

A cron job that runs every day at 9am UK time to check:

1. If someone's birthday is 7 days away, trigger a collection of messages.
2. If someone's birthday is today, post a thread to the birthday channel.

There are also some commands that can be used to set birthdays and trigger functions manually.