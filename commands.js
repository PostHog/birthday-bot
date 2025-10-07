const { db, statements } = require('./database');
const { postBirthdayThread, triggerBirthdayCollection } = require('./birthday-service');

// Simple in-memory cache for user data (expires after 5 minutes)
const userCache = new Map();
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes in milliseconds

// Helper function to format date
function formatDate(dateStr) {
  const [day, month] = dateStr.split('-');
  const date = new Date(2000, parseInt(month) - 1, parseInt(day));
  return date.toLocaleString('default', { month: 'long', day: 'numeric' });
}

// Helper function to search for a user by first and last name
async function findUserByName(client, firstName, lastName) {
  console.log(`Searching for user: ${firstName} ${lastName}`);
  
  // Check cache first
  const cacheKey = `${firstName.toLowerCase()}-${lastName.toLowerCase()}`;
  const cached = userCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
    console.log(`Found user in cache: ${cached.user.real_name || cached.user.name}`);
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

// Validate date format (DD-MM)
function isValidDate(dateStr) {
  if (!/^\d{2}-\d{2}$/.test(dateStr)) return false;
  
  const [day, month] = dateStr.split('-').map(Number);
  if (month < 1 || month > 12) return false;
  
  const daysInMonth = new Date(2000, month, 0).getDate();
  if (day < 1 || day > daysInMonth) return false;
  
  return true;
}

function registerCommands(app) {
  // Command to set birthday (DD-MM)
  app.command('/set-birthday', async ({ command, ack, say, client }) => {
    await ack();
    
    try {
      const parts = command.text.trim().split(' ');
      console.log(command);
      
      if (parts.length !== 2) {
        await say("Please use the format: `/set-birthday @user DD-MM`");
        return;
      }

      let [userMention, birthDate] = parts;

      if (!isValidDate(birthDate)) {
        await say("Please provide a valid date in DD-MM format (e.g., 11-02 for February 11th)");
        return;
      }

      try {
        // Because we set the Slack command setting to escape channels, users, and links
        // userMention is in the format <@U1234|username>, extract just the user ID
        const userId = userMention.replace(/^<@([A-Z0-9]+)\|[^>]+>$/, '$1');
        const userInfo = await client.users.info({ user: userId });
        const user = userInfo.user;
        
        if (!user) {
          throw new Error('User not found');
        }
        // Save to database
        statements.insertBirthday.run(user.id, birthDate);

        // Format date for display
        const formattedDate = formatDate(birthDate);
        const firstName = user.first_name || (user.real_name_normalized || user.real_name).split(' ')[0];

        await say({
          text: `Birthday set`,
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `✅ ${firstName}'s birthday set for *${formattedDate}*`
              }
            }
          ]
        });
      } catch (userError) {
        console.error('Error getting user info:', userError);
        await say(`Error looking up user. Please try again with their exact Slack username.`);
      }

    } catch (error) {
      console.error('Error in /set-birthday command:', error);
      await say("Sorry, there was an error setting the birthday. Please try again.");
    }
  });

  // Command to set birthday automatically using first name, last name and DD-MM (from Deel)
  app.command('/set-birthday-auto', async ({ command, ack, say, client }) => {
    await ack();
    
    try {
      // command.text will look like this: "/set-birthday-auto Ian Vanagas 11-02"
      const parts = command.text.trim().split(' ');

      // Validate input format
      if (parts.length < 3) {
        await say("Please use the format: `/set-birthday-auto FirstName LastName DD-MM`\nExample: `/set-birthday-auto John Smith 15-03`");
        return;
      }

      let [firstName, lastName, birthDate] = parts;

      // Validate date format
      if (!isValidDate(birthDate)) {
        await say("Please provide a valid date in DD-MM format (e.g., 11-02 for February 11th)");
        return;
      }

      // Validate names are not empty
      if (!firstName.trim() || !lastName.trim()) {
        await say("Please provide valid first and last names");
        return;
      }

      try {
        // Search for user using the extracted function
        const user = await findUserByName(client, firstName, lastName);
        
        if (!user) {
          throw new Error(`User not found: ${firstName} ${lastName}`);
        }

        // Save to database
        statements.insertBirthday.run(user.id, birthDate);

        // Format date for display
        const formattedDate = formatDate(birthDate);
        const slackFirstName = user.first_name || (user.real_name_normalized || user.real_name).split(' ')[0];

        await say({
          text: `Birthday set`,
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `✅ ${slackFirstName}'s birthday set for *${formattedDate}*`
              }
            }
          ]
        });

        console.log(`Successfully set birthday for ${user.real_name || user.name} (${user.id}): ${birthDate}`);
      } catch (userError) {
        console.error('User search error:', userError);
        
        // Provide more specific error messages
        if (userError.message.includes('User not found')) {
          await say({
            text: `User not found`,
            blocks: [
              {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: `❌ Could not find user: *${firstName} ${lastName}*\n\nPlease try:\n• Check the spelling of the name\n• Use the \`/set-birthday @username DD-MM\` command instead\n• Make sure the user exists in your Slack workspace`
                }
              }
            ]
          });
        } else {
          await say(`Error finding user: ${userError.message}. Please try the manual command: \`/set-birthday @username DD-MM\``);
        }
      }

    } catch (error) {
      console.error('Error in /set-birthday-auto command:', error);
      await say({
        text: "Error setting birthday",
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "❌ Sorry, there was an error setting the birthday.\n\nPlease try the manual command: `/set-birthday @username DD-MM`"
            }
          }
        ]
      });
    }
  });

  // Command to list all birthdays
  app.command('/see-birthdays', async ({ command, ack, say, client }) => {
    await ack();
    
    try {
      // Get all birthdays, ordered by upcoming date
      const birthdays = statements.getAllBirthdays.all();
      
      if (birthdays.length === 0) {
        await say("No birthdays have been set yet!");
        return;
      }

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

      const users = allUsers;

      // Group birthdays by month
      const birthdaysByMonth = birthdays.reduce((acc, birthday) => {
        
        // Skip placeholder birthdays
        if (birthday.birth_date === '1900-01-01') {
          return acc;
        }

        const [day, month] = birthday.birth_date.split('-');
        const date = new Date(2000, parseInt(month) - 1, parseInt(day));
        const monthName = date.toLocaleString('default', { month: 'long' });

        const user = users.find(user => user.id === birthday.user_id);
        let slackName;
        if (!user) {
          slackName = '<@' + birthday.user_id + '>';
        } else {
          slackName = user.real_name_normalized || user.real_name;
        }
        
        if (!acc[monthName]) {
          acc[monthName] = [];
        }
        acc[monthName].push({
          day: parseInt(day),
          slackName: slackName
        });
        return acc;
      }, {});

      // Create formatted message
      let message = "*🎂 Birthday Calendar*\n\n";
      
      for (const month of Object.keys(birthdaysByMonth)) {
        message += `*${month}*\n`;
        const sortedBirthdays = birthdaysByMonth[month].sort((a, b) => a.day - b.day);
        
        for (const bday of sortedBirthdays) {
          message += `• ${bday.day} - ${bday.slackName}\n`;
        }
        message += "\n";
      }

      await say({
        text: "Birthday Calendar",
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: message
            }
          }
        ]
      });

    } catch (error) {
      console.error('Error listing birthdays:', error);
      await say("Sorry, there was an error listing the birthdays.");
    }
  });

  app.command('/collect-birthday-messages', async ({ command, ack, client, say }) => {
    await ack();
    
    try {
      const [celebrantId] = command.text.split(' ');
      
      if (!celebrantId) {
        await say({
          text: "Please provide a user ID",
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: "Please provide a user ID.\nFormat: `/collect-birthday-messages @user`"
              }
            }
          ]
        });
        return;
      }

      // Because we set the Slack command setting to escape channels, users, and links
      // celebrantId is in the format <@U1234|username>, extract just the user ID
      const userId = celebrantId.replace(/^<@([A-Z0-9]+)\|[^>]+>$/, '$1');
      const userInfo = await client.users.info({ user: userId });
      const user = userInfo.user;
      
      if (!user) {
        throw new Error('User not found');
      }

      await triggerBirthdayCollection(client, user.id);
      await say({
        text: "Birthday message collection started",
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: ":mailbox_with_mail: Birthday message collection has been initiated!"
            }
          }
        ]
      });
    } catch (error) {
      console.error('Error handling collect command:', error);
      await say("An error occurred while starting the birthday message collection.");
    }
  });

  app.action('submit_birthday_content', async ({ body, ack, client, action }) => {
    try {
      await ack();
      
      // Extract celebrant ID from message text
      const match = body.message?.text?.match(/<@([A-Z0-9]+)>/);
      if (!match && !action.value) {
        console.error('Could not find celebrant ID in message or action');
        return;
      }
      const celebrantId = match[1]

      const senderId = body.user.id;

      // Ensure the celebrant exists in the birthdays table
      const exists = statements.checkUserExists.get(celebrantId);
      if (!exists.count) {
        throw new Error('User does not exist in birthdays table');
      }

      // Get sender's user info
      const userResult = await client.users.info({ user: senderId });
      const senderName = userResult.user.real_name || userResult.user.name;

      // Find the message, description and media input blocks
      const messageInputBlock = Object.values(body.state.values).find(block => 
        block.message_input !== undefined
      );
      const descriptionInputBlock = body.state.values.description_input_block;
      const mediaInputBlock = body.state.values.media_input_block;

      const messageText = messageInputBlock?.message_input.value;
      const descriptionText = descriptionInputBlock?.description_input.value;
      const mediaUrl = mediaInputBlock?.media_input.value;

      // Check if at least one input has content
      if (!messageText && !descriptionText) {
        await client.chat.postMessage({
          channel: senderId,
          text: "Please enter either a birthday message or description before submitting!"
        });
        return;
      }

      try {
        // Save message if provided (database will handle duplicates)
        if (messageText) {
          const result = statements.insertBirthdayMessage.run(
            celebrantId,    // who the birthday is for
            senderId,       // who sent the message
            senderName,     // sender's real name
            messageText,    // the actual message
            mediaUrl       // optional media URL
          );
          if (result.changes === 0) {
            console.log(`Duplicate birthday message prevented for ${senderId} -> ${celebrantId}`);
          }
        }

        // Save description if provided (database will handle duplicates)
        if (descriptionText) {
          const result = statements.insertDescriptionMessage.run(
            celebrantId,    // who the birthday is for
            senderId,       // who sent the description
            senderName,     // sender's real name
            descriptionText // the actual description
          );
          if (result.changes === 0) {
            console.log(`Duplicate description message prevented for ${senderId} -> ${celebrantId}`);
          }
        }

        // Customize confirmation message based on what was submitted
        let confirmationMessage = "Thanks for submitting your ";
        if (messageText && descriptionText) {
          confirmationMessage += "birthday message and description";
        } else if (messageText) {
          confirmationMessage += "birthday message";
        } else {
          confirmationMessage += "description";
        }
        if (mediaUrl) {
          confirmationMessage += " with media";
        }
        confirmationMessage += " for <@" + celebrantId + ">! 🎉";

        // Try to delete the original message containing the form
        try {
          await client.chat.delete({
            channel: body.channel.id,
            ts: body.message.ts
          });
        } catch (deleteError) {
          console.log('Could not delete original message (this is okay):', deleteError.message);
        }

        // Confirm receipt to the sender
        await client.chat.postMessage({
          channel: senderId,
          text: confirmationMessage
        });

        console.log(`Stored birthday content from ${senderId} for ${celebrantId}`);
      } catch (dbError) {
        console.error('Database error:', dbError);
        await client.chat.postMessage({
          channel: senderId,
          text: "Sorry, there was an error saving your submission(s). Please try again."
        });
      }

    } catch (error) {
      console.error('Error handling content submission:', error);
      try {
        await client.chat.postMessage({
          channel: body.user.id,
          text: "Sorry, there was an error submitting your content. Please let Ian know and try again."
        });
      } catch (msgError) {
        console.error('Error sending error message:', msgError);
      }
    }
  });

  app.command('/post-birthday-thread', async ({ command, ack, client, say }) => {
    await ack();
    
    try {
      const celebrantId = command.text.trim();
      
      if (!celebrantId) {
        await say({
          text: "Please provide a user ID",
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: "Please provide a user ID.\nFormat: `/post-birthday-thread @user`"
              }
            }
          ]
        });
        return;
      }

      // Because we set the Slack command setting to escape channels, users, and links
      // celebrantId is in the format <@U1234|username>, extract just the user ID
      const userId = celebrantId.replace(/^<@([A-Z0-9]+)\|[^>]+>$/, '$1');
      const userInfo = await client.users.info({ user: userId });
      const user = userInfo.user;
      
      if (!user) {
        throw new Error('User not found');
      }

      await postBirthdayThread(client, user.id);
      await say({
        text: "Birthday thread posted",
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: ":tada: Birthday thread has been posted!"
            }
          }
        ]
      });
    } catch (error) {
      console.error('Error handling post command:', error);
      await say("An error occurred while posting the birthday thread.");
    }
  });
}

module.exports = registerCommands;