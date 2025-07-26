import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  QueryCommand,
  PutCommand,
  GetCommand,
  BatchGetCommand,
} from "@aws-sdk/lib-dynamodb";
import { SESClient, SendBulkTemplatedEmailCommand } from "@aws-sdk/client-ses";
import admin from "firebase-admin";

const ddbClient = new DynamoDBClient();
const docClient = DynamoDBDocumentClient.from(ddbClient);
const ses = new SESClient();
const s3Client = new S3Client();

// Initialize Firebase Admin SDK
let firebaseInitialized = false;
async function initializeFirebase() {
  if (firebaseInitialized) return;
  try {
    const command = new GetObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: process.env.S3_FCM_KEY,
    });
    const response = await s3Client.send(command);
    const serviceAccountData = await response.Body.transformToString();
    const serviceAccount = JSON.parse(serviceAccountData);

    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: serviceAccount.project_id,
        clientEmail: serviceAccount.client_email,
        privateKey: serviceAccount.private_key,
      }),
    });
    firebaseInitialized = true;
    console.log("Firebase initialized successfully");
  } catch (error) {
    console.error("Failed to initialize Firebase:", error);
    throw new Error("Failed to initialize Firebase");
  }
}

// Retry mechanism with exponential backoff
async function withRetry(operation, maxRetries = 3, baseDelay = 1000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt === maxRetries) {
        console.error(`Operation failed after ${maxRetries} attempts:`, error);
        throw error;
      }
      const delay = baseDelay * Math.pow(2, attempt - 1);
      console.warn(
        `Attempt ${attempt} failed, retrying after ${delay}ms:`,
        error
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

export const handler = async (event) => {
  console.log("Received event:", JSON.stringify(event, null, 2));

  // Initialize Firebase
  try {
    await initializeFirebase();
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify("Failed to initialize Firebase"),
    };
  }

  for (const record of event.Records) {
    let message;
    try {
      message = JSON.parse(record.body);
    } catch (err) {
      console.error("Invalid message format:", record.body);
      continue;
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
      eventDetails = await withRetry(() =>
        docClient.send(
          new QueryCommand({
            TableName: process.env.EVENT_TABLE,
            KeyConditionExpression: "EventID = :eventId",
            ExpressionAttributeValues: { ":eventId": eventId },
          })
        )
      );
    } catch (err) {
      console.error(`DynamoDB error fetching event ${eventId}:`, err);
      continue;
    }

    if (!eventDetails.Items || eventDetails.Items.length === 0) {
      console.warn(`Event ${eventId} not found - skipping.`);
      continue;
    }

    const eventItem = eventDetails.Items[0];
    console.log("Event details:", JSON.stringify(eventItem, null, 2));

    if (!eventItem.EventDate || isNaN(new Date(eventItem.EventDate))) {
      console.warn(
        `Invalid or missing EventDate for event ${eventId} - skipping.`
      );
      continue;
    }

    const now = new Date();
    const eventTime = new Date(eventItem.EventDate);
    if (eventTime < now) {
      console.log(`Event ${eventId} is in the past - no notification needed.`);
      continue;
    }

    // Fetch recipients
    const recipients = await fetchRecipients(eventId);
    if (recipients.length === 0) {
      console.warn(`No recipients for event ${eventId} - skipping.`);
      continue;
    }

    const validRecipients = recipients.filter(
      (user) => user.email && user.email.includes("@") && user.pushToken
    );
    if (validRecipients.length === 0) {
      console.warn(`No valid recipients for event ${eventId} - skipping.`);
      continue;
    }

    const notifications = [];
    const emailDestinations = [];
    for (const user of validRecipients) {
      const notificationId = `${eventId}_${user.userId}_${eventType}`;

      // Check if notification was already sent
      if (await checkNotificationLog(notificationId)) {
        console.log(`Skipping notification ${notificationId}: already sent`);
        continue;
      }

      const email = user.email;
      const pushToken = user.pushToken;
      const subject = getSubject(eventType, eventItem);
      const body = getBody(eventType, eventItem);

      // Prepare email destination for bulk sending
      emailDestinations.push({
        Destination: { ToAddresses: [email] },
        ReplacementTemplateData: JSON.stringify({ subject, body }),
      });

      // Prepare push notification
      const eventDateTime = new Date(eventItem.EventDate);
      const formattedEventDate = eventDateTime.toLocaleDateString("en-IN", {
        day: "numeric",
        month: "long",
      });
      const formattedEventTime = eventDateTime.toLocaleTimeString("en-IN", {
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      });

      const message = {
        token: pushToken,
        notification: {
          title: `📢 Event Update: ${eventItem.EventTitle}`,
          body: `The event "${
            eventItem.EventTitle
          }" has been ${eventType.toLowerCase()} for ${formattedEventDate} at ${formattedEventTime}.`,
        },
        data: {
          event_id: eventId,
          event_type: eventType,
        },
      };

      notifications.push({
        message,
        notificationId,
        userId: user.userId,
        eventId,
        eventType,
      });
    }

    // Send bulk emails
    if (emailDestinations.length > 0) {
      console.log(`Sending ${emailDestinations.length} emails`);
      await sendBulkEmails(emailDestinations, eventType);
    }

    // Send push notifications and log
    if (notifications.length > 0) {
      console.log(`Sending ${notifications.length} push notifications`);
      await sendNotifications(notifications.map((n) => n.message));
      await Promise.all(
        notifications.map(({ notificationId, userId, eventId, eventType }) =>
          logNotification(notificationId, userId, eventId, eventType)
        )
      );
    }

    console.log(`Processed event ${eventId} successfully.`);
  }

  return { statusCode: 200, body: JSON.stringify("Done") };
};

// Fetch recipients using BatchGetItem
async function fetchRecipients(eventId) {
  const recipients = [];
  try {
    const bookingQuery = await withRetry(() =>
      docClient.send(
        new QueryCommand({
          TableName: process.env.BOOKING_TABLE,
          IndexName: "EventID-index",
          KeyConditionExpression: "EventID = :eventId",
          ExpressionAttributeValues: {
            ":eventId": eventId,
          },
        })
      )
    );

    const bookings = bookingQuery.Items || [];
    if (bookings.length === 0) {
      console.log(`No bookings found for event ${eventId}`);
      return recipients;
    }

    // Prepare keys for BatchGetItem
    const userKeys = bookings.map((booking) => ({
      UserID: booking.UserId,
    }));

    // Batch fetch user details
    const batchSize = 100; // DynamoDB BatchGetItem limit
    for (let i = 0; i < userKeys.length; i += batchSize) {
      const batchKeys = userKeys.slice(i, i + batchSize);
      try {
        const batchResponse = await withRetry(() =>
          docClient.send(
            new BatchGetCommand({
              RequestItems: {
                [process.env.USERS_TABLE]: {
                  Keys: batchKeys,
                },
              },
            })
          )
        );

        const users = batchResponse.Responses[process.env.USERS_TABLE] || [];
        users.forEach((user) => {
          if (user) {
            recipients.push({
              userId: user.UserID,
              email: user.Email,
              pushToken: user.pushToken,
            });
          }
        });

        // Handle unprocessed keys
        if (
          batchResponse.UnprocessedKeys &&
          batchResponse.UnprocessedKeys[process.env.USERS_TABLE]
        ) {
          console.warn(
            `Unprocessed keys in batch:`,
            batchResponse.UnprocessedKeys
          );
        }
      } catch (err) {
        console.error(`Error in BatchGetItem for users:`, err);
      }
    }
  } catch (err) {
    console.error(`Error querying BookingTable for event ${eventId}:`, err);
  }

  return recipients;
}

// Check notification log for idempotency
async function checkNotificationLog(notificationId) {
  try {
    const command = new GetCommand({
      TableName: process.env.NOTIFICATION_LOGS_TABLE,
      Key: { NotificationID: notificationId },
    });
    const response = await withRetry(() => docClient.send(command));
    return !!response.Item;
  } catch (error) {
    console.error(`Error checking notification log ${notificationId}:`, error);
    return false;
  }
}

// Log notification for idempotency
async function logNotification(notificationId, userId, eventId, eventType) {
  try {
    const command = new PutCommand({
      TableName: process.env.NOTIFICATION_LOGS_TABLE,
      Item: {
        NotificationID: notificationId,
        UserID: userId,
        EventID: eventId,
        EventType: eventType,
        Timestamp: new Date().toISOString(),
      },
    });
    await withRetry(() => docClient.send(command));
    console.log(`Logged notification ${notificationId}`);
  } catch (error) {
    console.error(`Error logging notification ${notificationId}:`, error);
  }
}

// Subject generator
function getSubject(type, event) {
  switch (type) {
    case "CANCELLED":
      return `Event Cancelled: ${event.EventTitle}`;
    case "RESCHEDULED":
      return `Event Rescheduled: ${event.EventTitle}`;
    case "VENUE_CHANGED":
      return `Venue Changed: ${event.EventTitle}`;
    case "EVENT_UPDATED":
      return `Event Updated: ${event.EventTitle}`;
    default:
      return `Update: ${event.EventTitle}`;
  }
}

// Body generator
function getBody(type, event) {
  return `
    Hello,

    This is to inform you that the event "${event.EventTitle}" has an update.

    Type: ${type}
    New Date/Time: ${event.EventDate}
    Venue: ${event.EventLocation || "No venue specified"}

    Thank you,
    Event Team
  `;
}

// Send bulk emails using SES
async function sendBulkEmails(destinations, eventType) {
  const templateName = `EventUpdateTemplate_${eventType}`;
  try {
    const params = {
      Source: process.env.SENDER_EMAIL,
      Template: templateName,
      DefaultTemplateData: JSON.stringify({ subject: "", body: "" }),
      Destinations: destinations,
    };
    await withRetry(() => ses.send(new SendBulkTemplatedEmailCommand(params)));
    console.log(`Bulk email sent to ${destinations.length} recipients`);
  } catch (err) {
    console.error(`Failed to send bulk email:`, err);
  }
}

// Send push notifications via FCM
async function sendNotifications(messages) {
  for (const message of messages) {
    try {
      const response = await withRetry(() => admin.messaging().send(message));
      console.log("Push notification sent successfully:", response);
    } catch (error) {
      console.error("Error sending push notification:", error);
    }
  }
}
