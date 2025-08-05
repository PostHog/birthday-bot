const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Use different data directories for production and development
const dataDir = process.env.NODE_ENV === 'production' ? '/data' : path.join(__dirname, 'data');

// Create directory if it doesn't exist (and we're not in production)
if (process.env.NODE_ENV !== 'production' && !fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir);
}

// Use a specific path for the database file
const dbPath = path.join(dataDir, 'birthdays.db');

// Initialize database with options for better error handling
const db = new Database(dbPath, {
  verbose: console.log, // This will log all SQL queries (remove in production)
  fileMustExist: false // Create the file if it doesn't exist
});

// Enable foreign keys and WAL mode for better performance
db.pragma('foreign_keys = ON');
db.pragma('journal_mode = WAL');

// Add this to your .gitignore
const gitignore = path.join(__dirname, '.gitignore');
if (!fs.existsSync(gitignore) || !fs.readFileSync(gitignore, 'utf8').includes('data/')) {
  fs.appendFileSync(gitignore, '\n# Database\ndata/\n');
}

// Initialize tables with more robust schema
db.exec(`
  CREATE TABLE IF NOT EXISTS birthdays (
    user_id TEXT PRIMARY KEY,
    birth_date TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    notification_sent BOOLEAN DEFAULT FALSE,
    last_notification_date TEXT
  );

  CREATE TABLE IF NOT EXISTS birthday_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    celebrant_id TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    sender_name TEXT NOT NULL,
    message TEXT NOT NULL,
    media_url TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    sent_in_thread BOOLEAN DEFAULT FALSE,
    FOREIGN KEY (celebrant_id) REFERENCES birthdays(user_id)
  );

  CREATE TABLE IF NOT EXISTS description_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    celebrant_id TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    sender_name TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    sent_in_thread BOOLEAN DEFAULT FALSE,
    FOREIGN KEY (celebrant_id) REFERENCES birthdays(user_id)
  );

  -- Add any indexes we need
  CREATE INDEX IF NOT EXISTS idx_birth_date ON birthdays(birth_date);
  CREATE INDEX IF NOT EXISTS idx_celebrant_messages ON birthday_messages(celebrant_id);
  CREATE INDEX IF NOT EXISTS idx_description_messages ON description_messages(celebrant_id);
`);

// Add a function to check database connection
function checkDatabase() {
  try {
    // Try a simple query
    const test = db.prepare('SELECT 1').get();
    if (test[1] === 1) {
      console.log('✅ Database connection successful');
      return true;
    }
  } catch (error) {
    console.error('❌ Database connection failed:', error);
    return false;
  }
}

// Export what we need
module.exports = {
  db,
  checkDatabase,
  statements: {
    insertBirthday: db.prepare(`
      INSERT OR REPLACE INTO birthdays (
        user_id, 
        birth_date, 
        updated_at,
        notification_sent,
        last_notification_date
      )
      VALUES (
        ?, 
        COALESCE(?, '1900-01-01'), /* Temporary date if none provided */
        CURRENT_TIMESTAMP,
        FALSE,
        NULL
      )
    `),

    getBirthday: db.prepare(`
      SELECT * FROM birthdays WHERE user_id = ?
    `),
    
    getAllBirthdays: db.prepare(`
      SELECT * FROM birthdays
    `),
    
    updateLastNotificationDate: db.prepare(`
      UPDATE birthdays
      SET last_notification_date = DATE('now')
      WHERE user_id = ?
    `),

    insertBirthdayMessage: db.prepare(`
      INSERT INTO birthday_messages (
        celebrant_id,
        sender_id,
        sender_name,
        message,
        media_url
      ) VALUES (?, ?, ?, ?, ?)
    `),

    getBirthdayMessages: db.prepare(`
      SELECT * FROM birthday_messages 
      WHERE celebrant_id = ? 
      AND sent_in_thread = FALSE
      ORDER BY created_at ASC
    `),

    getBirthdayMessageCount: db.prepare(`
      SELECT COUNT(*) as message_count FROM birthday_messages 
      WHERE celebrant_id = ? 
      AND sent_in_thread = FALSE
    `),

    markMessagesAsSent: db.prepare(`
      UPDATE birthday_messages
      SET sent_in_thread = TRUE
      WHERE celebrant_id = ?
      AND sent_in_thread = FALSE
    `),

    insertDescriptionMessage: db.prepare(`
      INSERT INTO description_messages (
        celebrant_id,
        sender_id,
        sender_name,
        message
      ) VALUES (?, ?, ?, ?)
    `),

    getDescriptionMessages: db.prepare(`
      SELECT * FROM description_messages 
      WHERE celebrant_id = ? 
      AND sent_in_thread = FALSE
      ORDER BY created_at ASC
    `), 

    markDescriptionMessagesAsSent: db.prepare(`
      UPDATE description_messages
      SET sent_in_thread = TRUE
      WHERE celebrant_id = ?
      AND sent_in_thread = FALSE
    `),

    checkUserExists: db.prepare(`
      SELECT COUNT(*) as count FROM birthdays WHERE user_id = ?
    `),

    checkDuplicateBirthdayMessage: db.prepare(`
      SELECT COUNT(*) as count FROM birthday_messages 
      WHERE celebrant_id = ? AND sender_id = ? AND message = ? AND sent_in_thread = FALSE
    `),

    checkDuplicateDescriptionMessage: db.prepare(`
      SELECT COUNT(*) as count FROM description_messages 
      WHERE celebrant_id = ? AND sender_id = ? AND message = ? AND sent_in_thread = FALSE
    `),
  }
};