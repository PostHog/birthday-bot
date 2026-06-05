// Shared helpers used by both the Slack commands and the webhook API.

// Simple in-memory cache for user lookups by name (expires after 5 minutes)
const userCache = new Map();
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes in milliseconds

// Format a DD-MM date string into something pretty, e.g. "February 11"
function formatDate(dateStr) {
  const [day, month] = dateStr.split('-');
  const date = new Date(2000, parseInt(month) - 1, parseInt(day));
  return date.toLocaleString('default', { month: 'long', day: 'numeric' });
}

// Validate date format (DD-MM)
function isValidDate(dateStr) {
  if (!/^\d{2}-\d{2}$/.test(dateStr)) return false;

  const [day, month] = dateStr.split('-').map(Number);
  if (month < 1 || month > 12) return false;

  const daysInMonth = new Date(2000, month, 0).getDate();
  if (day < 1 || day > daysInMonth) return false;

  return true;
}

// Normalize an incoming date into the DD-MM format the database uses.
// Accepts DD-MM (e.g. "11-02") or full ISO dates (e.g. "1990-02-11" / "2026-02-11").
// Returns a valid "DD-MM" string, or null if the input can't be parsed.
function normalizeDate(input) {
  if (input === undefined || input === null) return null;
  const s = String(input).trim();

  // ISO date: YYYY-MM-DD (year is ignored — we only store month/day)
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    const ddmm = `${iso[3]}-${iso[2]}`;
    return isValidDate(ddmm) ? ddmm : null;
  }

  // Native DD-MM format
  if (/^\d{2}-\d{2}$/.test(s)) {
    return isValidDate(s) ? s : null;
  }

  return null;
}

// Look up a Slack user by email address (most reliable identifier).
// Returns the Slack user object, or null if no active user matches.
async function findUserByEmail(client, email) {
  try {
    const response = await client.users.lookupByEmail({ email });
    if (response.user && !response.user.deleted) {
      return response.user;
    }
    return null;
  } catch (error) {
    // Slack returns "users_not_found" when no user has that email — treat as a miss
    if (error.data && error.data.error === 'users_not_found') {
      return null;
    }
    throw error;
  }
}

// Search the workspace for a user by first and last name.
// Mirrors the matching strategy used by the /set-birthday-auto command.
async function findUserByName(client, firstName, lastName) {
  console.log(`Searching for user: ${firstName} ${lastName}`);

  // Check cache first
  const cacheKey = `${firstName.toLowerCase()}-${lastName.toLowerCase()}`;
  const cached = userCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
    console.log(`Found user in cache: ${cached.user && (cached.user.real_name || cached.user.name)}`);
    return cached.user;
  }

  let user = null;
  let cursor = undefined;
  let searchAttempts = 0;
  const maxSearchAttempts = 10; // Prevent infinite loops

  do {
    searchAttempts++;
    if (searchAttempts > maxSearchAttempts) {
      console.log('Max search attempts reached, stopping search');
      break;
    }

    try {
      // Get all users from Slack
      const response = await client.users.list(cursor ? { cursor } : {});
      const memberList = response.members;

      // Try to find by real_name first
      user = memberList.find(
        m =>
          !m.deleted &&
          m.real_name &&
          m.real_name.trim().toLowerCase() === `${firstName} ${lastName}`.trim().toLowerCase()
      );

      // If not found, try profile.real_name_normalized
      if (!user) {
        user = memberList.find(
          m =>
            !m.deleted &&
            m.profile &&
            m.profile.real_name_normalized &&
            m.profile.real_name_normalized.trim().toLowerCase() === `${firstName} ${lastName}`.trim().toLowerCase()
        );
      }

      // If not found, try profile.display_name_normalized
      if (!user) {
        user = memberList.find(
          m =>
            !m.deleted &&
            m.profile &&
            m.profile.display_name_normalized &&
            m.profile.display_name_normalized.trim().toLowerCase() === `${firstName} ${lastName}`.trim().toLowerCase()
        );
      }

      // If not found, try profile.first_name (only if exactly one match)
      if (!user) {
        const firstNameMatches = memberList.filter(
          m =>
            !m.deleted &&
            m.profile &&
            m.profile.first_name &&
            m.profile.first_name.trim().toLowerCase() === firstName.trim().toLowerCase()
        );
        if (firstNameMatches.length === 1) {
          user = firstNameMatches[0];
        }
      }

      // If not found, try profile.last_name (only if exactly one match)
      if (!user) {
        const lastNameMatches = memberList.filter(
          m =>
            !m.deleted &&
            m.profile &&
            m.profile.last_name &&
            m.profile.last_name.trim().toLowerCase() === lastName.trim().toLowerCase()
        );
        if (lastNameMatches.length === 1) {
          user = lastNameMatches[0];
        }
      }

      if (user) {
        console.log(`Found user: ${user.real_name || user.name} (${user.id})`);
        // Cache the result
        userCache.set(cacheKey, {
          user: user,
          timestamp: Date.now()
        });
        break;
      }

      // If not found, try next page
      cursor = response.response_metadata && response.response_metadata.next_cursor
        ? response.response_metadata.next_cursor
        : undefined;
    } catch (error) {
      console.error('Error searching for user:', error);
      throw error;
    }
  } while (cursor && cursor.length > 0);

  // Cache negative results too (user not found)
  if (!user) {
    userCache.set(cacheKey, {
      user: null,
      timestamp: Date.now()
    });
  }

  return user;
}

module.exports = {
  formatDate,
  isValidDate,
  normalizeDate,
  findUserByEmail,
  findUserByName,
};
