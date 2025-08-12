const cron = require('node-cron');
const { db, statements } = require('./database');
const { triggerBirthdayCollection, postBirthdayThread } = require('./birthday-service');

const ADMIN_CHANNEL = process.env.ADMIN_CHANNEL;

// Automatically cleanup deactivated users
async function cleanupDeactivatedUsers(client) {
  try {
    const result = await client.users.list();
    const users = result.members;
    const birthdays = statements.getAllBirthdays.all();
    
    let deletedCount = 0;
    
    for (const birthday of birthdays) {
      const slackUser = users.find(user => user.id === birthday.user_id);
      
      // If user doesn't exist in Slack or is deleted, remove from database
      if (!slackUser || slackUser.deleted) {
        statements.deleteBirthdayMessagesForUser.run(birthday.user_id);
        statements.deleteDescriptionMessagesForUser.run(birthday.user_id);
        statements.deleteUser.run(birthday.user_id);
        deletedCount++;
      }
    }
    
    if (deletedCount > 0) {
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
        const today = new Date();
        const birthdayDate = new Date(today.getFullYear(), 
          parseInt(birthday.birth_date.split('-')[1]) - 1,
          parseInt(birthday.birth_date.split('-')[0])
        );
        
        const diffTime = birthdayDate.getTime() - today.getTime();
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        
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