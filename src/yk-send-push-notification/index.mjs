import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { DynamoDBClient, BatchGetItemCommand } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  QueryCommand,
  PutCommand,
  GetCommand,
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

  const requiredEnvVars = [
    "EVENT_TABLE",
    "BOOKING_TABLE",
    "USERS_TABLE",
    "NOTIFICATION_LOGS_TABLE",
    "SENDER_EMAIL",
  ];
  for (const varName of requiredEnvVars) {
    if (!process.env[varName]) {
      throw new Error(`Missing required env var: ${varName}`);
    }
  }

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
    const recipients = await getBookingsForEvent(eventId);
    if (recipients.length === 0) {
      console.warn(`No recipients for event ${eventId} - skipping.`);
      continue;
    }

    console.log("recipients:", JSON.stringify(recipients));

    const validRecipients = recipients
      .filter((r) => {
        const email = r.UserDetails?.Email;
        // const pushToken = r.UserDetails?.PushToken;

        return email && email.includes("@");
      })
      .map((r) => ({
        userId: r.UserDetails.UserID,
        email: r.UserDetails.Email,
        pushToken: r.UserDetails.PushToken,
      }));

    if (validRecipients.length === 0) {
      console.warn(`No valid recipients for event ${eventId} - skipping.`);
      continue;
    }

    console.log("validRecipients:", JSON.stringify(validRecipients));

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
      if (pushToken) {
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

        const pushMessage = {
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
          pushMessage,
          notificationId,
          userId: user.userId,
          eventId,
          eventType,
        });
      }
    }

    // Send bulk emails
    if (emailDestinations.length > 0) {
      console.log(`Sending ${emailDestinations.length} emails`);
      await sendBulkEmails(emailDestinations, eventType);
    }

    // Send push notifications and log
    if (notifications.length > 0) {
      console.log(`Sending ${notifications.length} push notifications`);
      await sendNotifications(notifications.map((n) => n.pushMessage));
      await Promise.all(
        notifications.map(({ notificationId, userId, eventId, eventType }) =>
          logNotification(notificationId, userId, eventId, eventType)
        )
      );
    }

    console.log({
      totalRecipients: recipients.length,
      validRecipients: validRecipients.length,
      pushNotificationCount: notifications.length,
      emailCount: emailDestinations.length,
    });

    console.log(`Processed event ${eventId} successfully.`);
  }

  return { statusCode: 200, body: JSON.stringify("Done") };
};

// Fetch recipients using BatchGetItem
// async function fetchRecipients(eventId) {
//   const recipients = [];
//   try {
//     const bookingQuery = await withRetry(() =>
//       docClient.send(
//         new QueryCommand({
//           TableName: process.env.BOOKING_TABLE,
//           IndexName: "EventID-index",
//           KeyConditionExpression: "EventID = :eventId",
//           ExpressionAttributeValues: {
//             ":eventId": eventId,
//           },
//         })
//       )
//     );

//     const bookings = bookingQuery.Items || [];
//     if (bookings.length === 0) {
//       console.log(`No bookings found for event ${eventId}`);
//       return recipients;
//     }

//     // Prepare keys for BatchGetItem
//     const userKeys = bookings.map((booking) => ({
//       UserID: booking.UserId,
//     }));

//     // Batch fetch user details
//     const batchSize = 100; // DynamoDB BatchGetItem limit
//     for (let i = 0; i < userKeys.length; i += batchSize) {
//       const batchKeys = userKeys.slice(i, i + batchSize);
//       try {
//         const batchResponse = await withRetry(() =>
//           docClient.send(
//             new BatchGetCommand({
//               RequestItems: {
//                 [process.env.USERS_TABLE]: {
//                   Keys: batchKeys,
//                 },
//               },
//             })
//           )
//         );

//         const users = batchResponse.Responses[process.env.USERS_TABLE] || [];
//         users.forEach((user) => {
//           if (user) {
//             recipients.push({
//               userId: user.UserID,
//               email: user.Email,
//               pushToken: user.pushToken,
//             });
//           }
//         });

//         // Handle unprocessed keys
//         if (
//           batchResponse.UnprocessedKeys &&
//           batchResponse.UnprocessedKeys[process.env.USERS_TABLE]
//         ) {
//           console.warn(
//             `Unprocessed keys in batch:`,
//             batchResponse.UnprocessedKeys
//           );
//         }
//       } catch (err) {
//         console.error(`Error in BatchGetItem for users:`, err);
//       }
//     }
//   } catch (err) {
//     console.error(`Error querying BookingTable for event ${eventId}:`, err);
//   }

//   return recipients;
// }

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

    const response = await withRetry(() =>
      ses.send(new SendBulkTemplatedEmailCommand(params))
    );

    console.log("SES response:", JSON.stringify(response, null, 2));

    // await withRetry(() => ses.send(new SendBulkTemplatedEmailCommand(params)));
    // console.log("SES response:", JSON.stringify(response, null, 2));
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

// Function to fetch bookings using EventID
async function getBookingsForEvent(eventId) {
  try {
    // Step 1: Query BookingDetails using GSI on EventID
    console.log("getBookingsForEvent :", eventId);
    const bookingResult = await ddbClient.send(
      new QueryCommand({
        TableName: "BookingDetails",
        IndexName: "EventID-index",
        KeyConditionExpression: "EventID = :eid",
        ExpressionAttributeValues: {
          ":eid": eventId,
        },
      })
    );

    console.log("Query result for bookings:", JSON.stringify(bookingResult));
    const bookings = bookingResult.Items || [];

    if (bookings.length === 0) {
      console.warn(`No valid recipients for event ${eventId} - skipping.`);
      return [];
    }

    // Step 2: Extract UserIds
    const userIds = bookings.map((item) => item.UserId).filter((id) => !!id);

    // Step 3: BatchGet from UsersTable
    const userBatchResult = await ddbClient.send(
      new BatchGetItemCommand({
        RequestItems: {
          UsersTable: {
            Keys: userIds.map((uid) => ({ UserID: { S: uid } })),
          },
        },
      })
    );

    console.log("userBatchResult", JSON.stringify(userBatchResult));

    const usersMap = {};
    const userItems = userBatchResult.Responses?.UsersTable || [];
    for (const user of userItems) {
      usersMap[user.UserID.S] = user;
    }

    // Step 4: Merge booking with user info
    console.log("bookings", JSON.stringify(bookings));

    const enriched = bookings.map((b) => {
      const uid = b.UserId;
      const user = usersMap[uid];
      console.log("user", JSON.stringify(user));

      return {
        BookingID: b.BookingID,
        UserId: uid,
        EventID: b.EventID,
        BookingStatus: b.BookingStatus,
        BookingName: b.BookingName,
        BookingEmail: b.BookingEmail,
        SeatsBooked: parseInt(b.SeatsBooked || "0"),
        TotalAmountPaid: parseFloat(b.TotalAmountPaid || "0"),
        // User Info
        UserDetails: user
          ? {
              Name: user.Name?.S,
              Email: user.Email?.S,
              Phone: user.Phone?.S,
              Token: user.pushToken?.s,
              // add any other user fields
            }
          : null,
      };
    });

    return enriched;
  } catch (error) {
    console.error("Error in getBookingsForEvent:", error);
    throw error;
  }
}
