const crypto = require('crypto');
const express = require('express');
const { statements } = require('./database');
const {
  normalizeDate,
  formatDate,
  findUserByEmail,
  findUserByName,
} = require('./utils');

// Constant-time comparison so we don't leak the key length/contents via timing.
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Post a notification to the admin channel. Best-effort: a failure here must
// never affect the API response, so errors are swallowed (just logged).
async function notifyAdmin(client, text) {
  const channel = process.env.ADMIN_CHANNEL;
  if (!channel) return;
  try {
    await client.chat.postMessage({ channel, text });
  } catch (error) {
    console.error('Failed to post API notification to admin channel:', error.message);
  }
}

// Human-readable summary of the identifiers a request supplied (for notifications).
function describeIdentifiers({ slack_user_id, email, first_name, last_name }) {
  const parts = [];
  if (slack_user_id) parts.push(`id ${slack_user_id}`);
  if (email) parts.push(`email ${email}`);
  if (first_name && last_name) parts.push(`name ${first_name} ${last_name}`);
  return parts.length ? parts.join(', ') : 'none';
}

// Pull the API key from either `Authorization: Bearer <key>` or `X-API-Key: <key>`.
function extractApiKey(req) {
  const auth = req.get('authorization');
  if (auth && auth.startsWith('Bearer ')) {
    return auth.slice('Bearer '.length).trim();
  }
  const headerKey = req.get('x-api-key');
  if (headerKey) return headerKey.trim();
  return null;
}

// Registers the webhook endpoint used by external tools (HR system, Zapier, etc.)
// to set birthdays automatically.
//
//   POST /api/birthdays
//   Authorization: Bearer <WEBHOOK_API_KEY>     (or X-API-Key: <WEBHOOK_API_KEY>)
//   Content-Type: application/json
//   {
//     "birthday": "1990-02-11",        // required — DD-MM or full ISO date (YYYY-MM-DD)
//     "slack_user_id": "U123ABC",      // optional — tried first
//     "email": "person@example.com",   // optional — tried second
//     "first_name": "Ian",             // optional — tried last (needs last_name too)
//     "last_name": "Vanagas"
//   }
//
// At least one identifier must be provided. They are resolved in priority order:
// Slack user ID, then email, then first/last name.
function registerApiRoutes(expressApp, client) {
  const apiKey = process.env.WEBHOOK_API_KEY;

  expressApp.post('/api/birthdays', express.json(), async (req, res) => {
    // Refuse to run unauthenticated — a missing key is a configuration error.
    if (!apiKey) {
      console.error('WEBHOOK_API_KEY is not set; rejecting /api/birthdays request');
      return res.status(503).json({ error: 'API not configured' });
    }

    const provided = extractApiKey(req);
    if (!provided || !safeEqual(provided, apiKey)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const body = req.body || {};
    const { slack_user_id, email, first_name, last_name } = body;

    // Validate and normalize the date up front.
    const birthDate = normalizeDate(body.birthday);
    if (!birthDate) {
      await notifyAdmin(client, `⚠️ API birthday request rejected: invalid or missing date \`${body.birthday}\` (${describeIdentifiers(body)})`);
      return res.status(400).json({
        error: 'Invalid or missing "birthday". Use DD-MM (e.g. "11-02") or ISO (e.g. "1990-02-11").'
      });
    }

    if (!slack_user_id && !email && !(first_name && last_name)) {
      await notifyAdmin(client, '⚠️ API birthday request rejected: no identifier provided (need `slack_user_id`, `email`, or `first_name` + `last_name`)');
      return res.status(400).json({
        error: 'Provide at least one identifier: "slack_user_id", "email", or both "first_name" and "last_name".'
      });
    }

    try {
      let user = null;
      let matchedBy = null;

      // 1. Slack user ID (most precise)
      if (slack_user_id) {
        try {
          const info = await client.users.info({ user: slack_user_id });
          if (info.user && !info.user.deleted) {
            user = info.user;
            matchedBy = 'slack_user_id';
          }
        } catch (error) {
          console.log(`slack_user_id lookup failed for ${slack_user_id}: ${error.data && error.data.error || error.message}`);
        }
      }

      // 2. Email
      if (!user && email) {
        user = await findUserByEmail(client, email);
        if (user) matchedBy = 'email';
      }

      // 3. First + last name
      if (!user && first_name && last_name) {
        user = await findUserByName(client, first_name, last_name);
        if (user) matchedBy = 'name';
      }

      if (!user) {
        await notifyAdmin(client, `⚠️ API birthday request failed: no Slack user matched (tried ${describeIdentifiers(body)}) for date *${formatDate(birthDate)}*`);
        return res.status(404).json({
          error: 'Could not find a matching Slack user',
          tried: { slack_user_id: slack_user_id || null, email: email || null, name: first_name && last_name ? `${first_name} ${last_name}` : null }
        });
      }

      // Store it (INSERT OR REPLACE — same behavior as the slash commands).
      statements.insertBirthday.run(user.id, birthDate);

      console.log(`API set birthday for ${user.real_name || user.name} (${user.id}) to ${birthDate} via ${matchedBy}`);

      const displayName = user.real_name || user.name || user.id;
      await notifyAdmin(client, `✅ Birthday set via API: ${displayName} (${user.id}) → *${formatDate(birthDate)}* (\`${birthDate}\`), matched by ${matchedBy}`);

      return res.status(200).json({
        ok: true,
        user_id: user.id,
        birthday: birthDate,
        formatted: formatDate(birthDate),
        matched_by: matchedBy,
      });
    } catch (error) {
      console.error('Error in POST /api/birthdays:', error);
      await notifyAdmin(client, `❌ API birthday request errored (${describeIdentifiers(body)}): ${error.message}`);
      return res.status(500).json({ error: 'Internal error setting birthday' });
    }
  });
}

module.exports = registerApiRoutes;
