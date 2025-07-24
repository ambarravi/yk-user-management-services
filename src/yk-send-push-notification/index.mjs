import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";

const ddbClient = new DynamoDBClient();
const docClient = DynamoDBDocumentClient.from(ddbClient);
const ses = new SESClient();

export const handler = async (event) => {
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

    let eventDetails;
    try {
      eventDetails = await docClient.send(
        new GetCommand({
          TableName: process.env.EVENT_TABLE,
          Key: { EventID: eventId },
        })
      );
    } catch (err) {
      console.error(`DynamoDB error fetching event ${eventId}:`, err);
      continue;
    }

    if (!eventDetails.Item) {
      console.warn(`Event ${eventId} not found - skipping.`);
      continue;
    }

    const eventItem = eventDetails.Item;

    console.log(eventDetails.Item);
    if (!eventItem.EventDate || isNaN(new Date(eventItem.EventDate))) {
      console.warn(
        `Invalid or missing EventDateTime for event ${eventId} - skipping.`
      );
      continue;
    }

    const now = new Date();
    const eventTime = new Date(eventItem.EventDate);
    if (eventTime < now) {
      console.log(`Event ${eventId} is in the past - no notification needed.`);
      continue;
    }

    // const recipients = eventItem.RegisteredUsers || [];
    // if (recipients.length === 0) {
    //   console.warn(`No recipients for event ${eventId} - skipping.`);
    //   continue;
    // }

    // const validRecipients = recipients.filter(
    //   (user) => user.email && user.email.includes("@")
    // );
    // if (validRecipients.length === 0) {
    //   console.warn(
    //     `No valid recipient emails for event ${eventId} - skipping.`
    //   );
    //   continue;
    // }

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

// Subject generator
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

// Body generator
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

// SES email sender
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
    await ses.send(new SendEmailCommand(params));
    console.log(`Email sent to ${to}`);
  } catch (err) {
    console.error(`Failed to send email to ${to}:`, err);
  }
}
