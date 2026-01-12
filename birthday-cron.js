const cron = require('node-cron');
const { db, statements } = require('./database');
const { triggerBirthdayCollection, postBirthdayThread } = require('./birthday-service');

const ADMIN_CHANNEL = process.env.ADMIN_CHANNEL;

// Automatically cleanup deactivated users
async function cleanupDeactivatedUsers(client) {
  try {
    const birthdays = statements.getAllBirthdays.all();
    let deletedCount = 0;
    
    // Get all users with pagination
    let allUsers = [];
    let cursor = undefined;
    let searchAttempts = 0;
    const maxSearchAttempts = 10; // Prevent infinite loops
    
    do {
      searchAttempts++;
      if (searchAttempts > maxSearchAttempts) {
        console.log('Max search attempts reached, stopping user list pagination');
        break;
      }

      try {
        // Get users from Slack with pagination
        const response = await client.users.list(cursor ? { cursor } : {});
        const memberList = response.members;
        
        // Add users to our collection
        allUsers = allUsers.concat(memberList);
        
        // Get next cursor for pagination
        cursor = response.response_metadata && response.response_metadata.next_cursor
          ? response.response_metadata.next_cursor
          : undefined;
      } catch (error) {
        console.error('Error fetching users list:', error);
        throw error;
      }
    } while (cursor && cursor.length > 0);
    
    // Now process birthdays against all users
    for (const birthday of birthdays) {
      const slackUser = allUsers.find(user => user.id === birthday.user_id);
      
      // If user doesn't exist in Slack or is deleted, remove from database
      if (!slackUser || slackUser.deleted) {
        statements.deleteBirthdayMessagesForUser.run(birthday.user_id);
        statements.deleteDescriptionMessagesForUser.run(birthday.user_id);
        statements.deleteUser.run(birthday.user_id);
        deletedCount++;
      }
    }
    
    if (deletedCount > 0) {
      await client.chat.postMessage({
        channel: ADMIN_CHANNEL,
        text: `${deletedCount} deactivated users cleaned up from database`
      });
      console.log(`Cleaned up ${deletedCount} deactivated users from database`);
    }
  } catch (error) {
    console.error('Error cleaning up deactivated users:', error);
  }
}

function setupCronJobs(app) {
  // Run every day at 9:00 AM Europe/London time
  cron.schedule('0 9 * * *', async () => {

  // Run every minute (for testing)
  // cron.schedule('*/1 * * * *', async () => {

    try {
      // Clean up deactivated users first
      await cleanupDeactivatedUsers(app.client);
      // Get today's birthdays and upcoming (7 days) birthdays
      const upcomingBirthdays = statements.getAllBirthdays.all();
      
      for (const birthday of upcomingBirthdays) {
        // Get current date in London timezone
        const today = new Date(new Date().toLocaleString("en-US", {timeZone: "Europe/London"}));
        today.setHours(0, 0, 0, 0); // Set to midnight for date-only comparison

        const birthdayDate = new Date(today.getFullYear(),
          parseInt(birthday.birth_date.split('-')[1]) - 1,
          parseInt(birthday.birth_date.split('-')[0])
        );

        // If the birthday has already passed this year, use next year
        if (birthdayDate < today) {
          birthdayDate.setFullYear(today.getFullYear() + 1);
        }

        const diffTime = birthdayDate.getTime() - today.getTime();
        const diffDays = Math.round(diffTime / (1000 * 60 * 60 * 24));
        
        if (diffDays === 7) {
          console.log(`Triggering collection for ${birthday.user_id}`)
          // Trigger collection for birthdays in 7 days
          await triggerBirthdayCollection(app.client, birthday.user_id);
        } else if (diffDays === 1) {
          const messageCount = statements.getBirthdayMessageCount.get(birthday.user_id).message_count || 0;

          await app.client.chat.postMessage({
            channel: ADMIN_CHANNEL,
            text: `${messageCount} messages collected for upcoming birthday`
          });
        } else if (diffDays === 0) {
          console.log(`Posting thread for ${birthday.user_id}`)
          // Post thread for today's birthdays
          await postBirthdayThread(app.client, birthday.user_id);
        }
      }
    } catch (error) {
      console.error('Error in birthday cron job:', error);
    }
  }, {
    timezone: "Europe/London"
  });
}

module.exports = { setupCronJobs };