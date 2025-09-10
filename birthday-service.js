const cron = require('node-cron');
const { db, statements } = require('./database');
const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Channel IDs where messages will be posted
const BIRTHDAY_CHANNEL = process.env.BIRTHDAY_CHANNEL;
const ADMIN_CHANNEL = process.env.ADMIN_CHANNEL;

// Description message prompts
const descriptionPrompts = [
  "What makes them unique and essential?",
  "What's something you admire about them?",
  "What's their defining feature?",
  "What makes them amazing to work with?",
  "How would you describe them in one word?",
  "What's their superpower?"
];

// Function to get a random description prompt
const getRandomPrompt = () => {
  const randomIndex = Math.floor(Math.random() * descriptionPrompts.length);
  return descriptionPrompts[randomIndex];
};

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function chunk(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

async function generateBirthdayPoem(descriptions) {
  try {
    // Format descriptions into a single string
    const descriptionsText = descriptions
      .map(desc => desc.message)
      .join('\n');

    // Create the prompt for Claude
    const prompt = `Based on these descriptions of some from their colleagues:\n\n${descriptionsText}\n\nWrite a warm, personal, and fun birthday poem that incorporates these qualities and characteristics. The poem should be light-hearted and celebratory. Just return the poem and no introduction or other text. Format it with line breaks.`;

    // Call Claude API
    const response = await anthropic.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 150,
      temperature: 0.7,
      messages: [{
        role: 'user',
        content: prompt
      }]
    });

    console.log(response)

    // Extract the poem from the response
    const poem = response.content[0].text.trim();
    return poem;

  } catch (error) {
    console.error('Error generating poem with Claude:', error);
    // Return a fallback poem if Claude API fails
    return "Here's to another year of joy and cheer,\nWith colleagues who hold you ever so dear.\nYour presence makes our workplace bright,\nHappy birthday, may your day be just right!";
  }
}

const generateBirthdayCollectionBlocks = (celebrantId) => {
  const descriptionPrompt = getRandomPrompt();
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `Hey! :birthday: *<@${celebrantId}>* has a birthday coming up in 7 days!`
      }
    },
    {
      type: "input",
      block_id: "message_input_block",
      element: {
        type: "plain_text_input",
        action_id: "message_input",
        multiline: true,
        placeholder: {
          type: "plain_text",
          text: "Type your birthday message here..."
        }
      },
      label: {
        type: "plain_text",
        text: "Your Birthday Message"
      }
    },
    {
      type: "input",
      block_id: "media_input_block",
      element: {
        type: "plain_text_input",
        action_id: "media_input",
        placeholder: {
          type: "plain_text",
          text: "Paste a URL to a GIF or image..."
        }
      },
      label: {
        type: "plain_text", 
        text: "Optional: Add Media (Hint: Use /giphy to search for a GIF and copy the URL)"
      },
      optional: true
    },
    {
      type: "divider"
    },
    {
      type: "input",
      block_id: "description_input_block",
      element: {
        type: "plain_text_input",
        action_id: "description_input",
        multiline: true,
        placeholder: {
          type: "plain_text",
          text: `${descriptionPrompt}`
        }
      },
      label: {
        type: "plain_text",
        text: "Describe Them"
      },
      optional: true
    },
    {
      type: "actions",
      block_id: "submit_block",
      elements: [
        {
          type: "button",
          text: {
            type: "plain_text",
            text: "Submit",
            emoji: true
          },
          action_id: "submit_birthday_content",
          value: `${celebrantId}`
        }
      ]
    }
  ]
}

const checkBirthdayExists = (users, celebrantId) => {
  // Takes a list of users and the celebrantId, checks that birthdays exist for all of them, and returns a list of users without birthdays
  const birthdays = statements.getAllBirthdays.all();
  const validBirthdays = birthdays.filter(b => b.user_id !== null && b.user_id !== undefined);
  const birthdayUserIds = new Set(validBirthdays.map(b => b.user_id));
  const missingBirthdayUserIds = users
    .map(u => u.id)
    .filter(id => id !== celebrantId && !birthdayUserIds.has(id));

  return missingBirthdayUserIds;
}

async function triggerBirthdayCollection(client, celebrantId) {
  try {
    const exists = statements.checkUserExists.get(celebrantId);
    if (!exists.count) {
      throw new Error('User does not exist in birthdays table');
    }

    const today = new Date().toISOString().split('T')[0];
    const birthday = statements.getBirthday.get(celebrantId);
    
    if (birthday.last_notification_date === today) {
      console.log(`Already sent notifications for ${celebrantId} today`);
      return;
    }
    
    const result = await client.users.list();
    const users = result.members.filter(user => 
      !user.is_bot && 
      !user.deleted &&
      !user.is_restricted && 
      !user.is_ultra_restricted &&
      user.id !== celebrantId && 
      user.id !== 'USLACKBOT' &&
      user.name !== celebrantId
    );

    const userBatches = chunk(users, 10);

    console.log(`Attempting to send messages to ${users.length} users in ${userBatches.length} batches`);

    for (const batch of userBatches) {
      // Process each batch with a delay between batches
      await Promise.all(batch.map(async (user) => {
        try {
          // Try to open a DM channel first
          try {
            const conversationResponse = await client.conversations.open({
              users: user.id
            });
            
            if (!conversationResponse.ok) {
              console.log(`Cannot open DM with user ${user.id}`);
              return;
            }
          } catch (dmError) {
            console.log(`Error opening DM with user ${user.id}:`, dmError);
            return;
          }

          console.log(`Sending birthday message collection to ${user.id}`);

          await client.chat.postMessage({
            channel: user.id,
            text: `Birthday message collection for <@${celebrantId}>`,
            blocks: generateBirthdayCollectionBlocks(celebrantId)
          });
        } catch (error) {
          console.error(`Error sending birthday collection message to ${user.id}:`, error);
        }
      }));
      
      // Add delay between batches to prevent rate limiting
      await delay(2500);
    }

    await client.chat.postMessage({
      channel: ADMIN_CHANNEL,
      text: `Birthday message collection sent to ${users.length} users`
    });

    console.log(`Updating last notification date for ${celebrantId}`);
    statements.updateLastNotificationDate.run(celebrantId);

    console.log(`Checking for missing birthdays`);
    const missingBirthdayUserIds = checkBirthdayExists(users, celebrantId);
    if (missingBirthdayUserIds.length > 0) {
      console.log(`Found ${missingBirthdayUserIds.length} missing birthdays`);
      
      // Get user info for all missing users in parallel
      const userInfoPromises = missingBirthdayUserIds.map(userId => 
        client.users.info({ user: userId })
      );
      const userInfos = await Promise.all(userInfoPromises);
      
      const missingBirthdayNames = userInfos
        .map(userInfo => userInfo.user.real_name || userInfo.user.name)
        .join(', ');

      await client.chat.postMessage({
        channel: ADMIN_CHANNEL,
        text: `Users missing birthdays: ${missingBirthdayNames}`
      });
    }
  } catch (error) {
    await client.chat.postMessage({
      channel: ADMIN_CHANNEL,
      text: `Error with birthday collection`
    });
    console.error('Error triggering birthday collection:', error);
  }
}

async function postBirthdayThread(client, celebrantId) {
  try {

    console.log(`Getting birthday messages for ${celebrantId}`);
    const messages = statements.getBirthdayMessages.all(celebrantId);

    if (messages.length === 0) {
      await client.chat.postMessage({
        channel: ADMIN_CHANNEL,
        text: `:sob: No birthday messages found for ${celebrantId}`
      });
      console.log(`No birthday messages found for ${celebrantId}`);
      return;
    }

    const mainPost = await client.chat.postMessage({
      channel: BIRTHDAY_CHANNEL,
      text: `Happy Birthday <@${celebrantId}>! 🎂`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `:birthday: *Happy Birthday <@${celebrantId}>!* :balloon:\n\nYour colleagues have some special messages for you! Check out the thread below. :arrow_down:`
          }
        }
      ]
    });

    console.log(`Getting descriptions for ${celebrantId}`);
    // Get all descriptions and combine them into one message
    const descriptions = statements.getDescriptionMessages.all(celebrantId);
    
    if (descriptions.length > 0) {
      // Generate poem from descriptions
      console.log(`Generating poem for ${celebrantId}`);
      const poem = await generateBirthdayPoem(descriptions);

      // Post the poem first in the thread
      console.log(`Posting poem for ${celebrantId}`);
      await client.chat.postMessage({
        channel: BIRTHDAY_CHANNEL,
        thread_ts: mainPost.ts,
        text: "*A special birthday poem for you:*\n\n" + poem + "\n\n:birthday: :sparkles: :cake:"
      });

      // Post the descriptions
      let descriptionMessage = "*Here's what your colleagues say about you:*\n\n";
      for (const desc of descriptions) {
        descriptionMessage += `• ${desc.message} _- ${desc.sender_name}_\n\n`;
      }
      
      await client.chat.postMessage({
        channel: BIRTHDAY_CHANNEL,
        thread_ts: mainPost.ts,
        text: descriptionMessage
      });

      // Mark descriptions as sent
      statements.markDescriptionMessagesAsSent.run(celebrantId);
    }
    
    for (const message of messages) {
      console.log(`Posting birthday message for ${celebrantId} from ${message.sender_name}`);
      let text = `${message.sender_name} says:\n${message.message}`;
      if (message.media_url) {
        text += `<${message.media_url}|.>`;
      }
      await client.chat.postMessage({
        channel: BIRTHDAY_CHANNEL,
        thread_ts: mainPost.ts,
        text: text
      });
    }

    // Mark messages as sent
    statements.markMessagesAsSent.run(celebrantId);

  } catch (error) {
    await client.chat.postMessage({
      channel: ADMIN_CHANNEL,
      text: `Error with birthday thread`
    });
    console.error('Error posting birthday thread:', error);
  }
}

module.exports = {
  postBirthdayThread,
  triggerBirthdayCollection
};