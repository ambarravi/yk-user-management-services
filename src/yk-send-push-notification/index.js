const AWS = require("aws-sdk");
const docClient = new AWS.DynamoDB.DocumentClient();
const ses = new AWS.SES();

exports.handler = async (event) => {
  console.log("Received event:", JSON.stringify(event, null, 2));

  for (const record of event.Records) {
    let message;
    try {
      message = JSON.parse(record.body);
    } catch (err) {
      console.error("Invalid message format:", record.body);
      continue; // Skip invalid messages
    }

    const { eventId, eventType } = message;
    console.log(`Processing eventId: ${eventId}, type: ${eventType}`);

    // Validation 1: Check eventType is supported
    const allowedTypes = [
      "CANCELLED",
      "RESCHEDULED",
      "VENUE_CHANGED",
      "EVENT_UPDATED",
    ];
    if (!allowedTypes.includes(eventType)) {
      console.warn(`Unsupported eventType "${eventType}" - skipping.`);
      continue;
    }

    // Validation 2: Event must exist in DB
    const eventDetails = await docClient
      .get({
        TableName: process.env.EVENT_TABLE,
        Key: { id: eventId },
      })
      .promise();

    if (!eventDetails.Item) {
      console.warn(`Event ${eventId} not found - skipping.`);
      continue;
    }

    const eventItem = eventDetails.Item;

    // Validation 3: Event must have a valid datetime
    if (!eventItem.EventDateTime || isNaN(new Date(eventItem.EventDateTime))) {
      console.warn(
        `Invalid or missing EventDateTime for event ${eventId} - skipping.`
      );
      continue;
    }

    // Validation 4: Don't notify for past events
    const now = new Date();
    const eventTime = new Date(eventItem.EventDateTime);
    if (eventTime < now) {
      console.log(`Event ${eventId} is in the past - no notification needed.`);
      continue;
    }

    // Validation 5: Check if recipients are available
    const recipients = eventItem.RegisteredUsers || [];
    if (recipients.length === 0) {
      console.warn(`No recipients for event ${eventId} - skipping.`);
      continue;
    }

    // Validation 6: Ensure each recipient has valid email
    const validRecipients = recipients.filter(
      (user) => user.email && user.email.includes("@")
    );
    if (validRecipients.length === 0) {
      console.warn(
        `No valid recipient emails for event ${eventId} - skipping.`
      );
      continue;
    }

    // Send email to valid recipients
    for (const user of validRecipients) {
      const email = user.email;
      const subject = getSubject(eventType, eventItem);
      const body = getBody(eventType, eventItem);

      await sendEmail(email, subject, body);
    }

    console.log(`Processed event ${eventId} successfully.`);
  }

  return { statusCode: 200, body: JSON.stringify("Done") };
};

// Helper: Get Email Subject
function getSubject(type, event) {
  switch (type) {
    case "CANCELLED":
      return `Event Cancelled: ${event.title}`;
    case "RESCHEDULED":
      return `Event Rescheduled: ${event.title}`;
    case "VENUE_CHANGED":
      return `Venue Changed: ${event.title}`;
    case "EVENT_UPDATED":
      return `Event Updated: ${event.title}`;
    default:
      return `Update: ${event.title}`;
  }
}

// Helper: Get Email Body
function getBody(type, event) {
  return `
    Hello,

    This is to inform you that the event "${event.title}" has an update.

    Type: ${type}
    New Date/Time: ${event.EventDateTime}
    Venue: ${event.venue || "No venue specified"}

    Thank you,
    Event Team
  `;
}

// Helper: Send email via SES
async function sendEmail(to, subject, body) {
  const params = {
    Destination: { ToAddresses: [to] },
    Message: {
      Body: { Text: { Charset: "UTF-8", Data: body } },
      Subject: { Charset: "UTF-8", Data: subject },
    },
    Source: process.env.SENDER_EMAIL,
  };

  try {
    await ses.sendEmail(params).promise();
    console.log(`Email sent to ${to}`);
  } catch (err) {
    console.error(`Failed to send email to ${to}:`, err);
  }
}

// Sample SQS Messages
// // Cancellation
// {
//   "type": "CANCELLED",
//   "eventId": "evt123"
// }

// // Rescheduled
// {
//   "type": "RESCHEDULED",
//   "eventId": "evt123",
//   "oldEventDate": "2025-07-20"
// }

// // Venue Changed
// {
//   "type": "VENUE_CHANGED",
//   "eventId": "evt123",
//   "oldVenue": "Old Hall A"
// }

// // Generic Event Update
// {
//   "type": "EVENT_UPDATED",
//   "eventId": "evt123",
//   "updatedFields": ["Category", "Host"]
// }
