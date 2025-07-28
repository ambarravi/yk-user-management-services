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
        return email && email.includes("@");
      })
      .map((r) => {
        const recipient = {
          userId: r.UserId,
          email: r.UserDetails.Email,
          pushToken: r.UserDetails.Token,
          name: r.BookingName,
          bookingId: r.BookingID,
        };
        console.log(
          `Recipient userId: ${r.UserId}, pushToken: ${r.UserDetails.Token}, bookingId: ${r.BookingID}`
        );
        return recipient;
      });

    if (validRecipients.length === 0) {
      console.warn(`No valid recipients for event ${eventId} - skipping.`);
      continue;
    }

    console.log("validRecipients:", JSON.stringify(validRecipients));

    const notifications = [];
    const emailDestinations = [];
    for (const user of validRecipients) {
      const pushNotificationId = `PUSH_${eventId}_${user.userId}_${eventType}`;
      const emailNotificationId = `EMAIL_${eventId}_${user.userId}_${eventType}`;

      const pushCheck = await checkNotificationLog(pushNotificationId);
      const canSendPush =
        !pushCheck.exists ||
        (pushCheck.timestamp &&
          (new Date().getTime() - new Date(pushCheck.timestamp).getTime()) /
            1000 >
            3600 &&
          (pushCheck.sendCount || 0) < 5);

      const emailCheck = await checkNotificationLog(emailNotificationId);
      const canSendEmail =
        !emailCheck.exists ||
        (emailCheck.timestamp &&
          (new Date().getTime() - new Date(emailCheck.timestamp).getTime()) /
            1000 >
            3600);

      const email = user.email;
      const booking_name = user.name;
      const pushToken = user.pushToken;
      const subject = getSubject(eventType, eventItem);
      const body = getBody(eventType, eventItem, booking_name);

      if (canSendEmail) {
        console.log(
          `Preparing email for ${email}: Subject=${subject}, Body=${body}`
        );
        emailDestinations.push({
          Destination: { ToAddresses: [email] },
          ReplacementTemplateData: JSON.stringify({
            subject,
            body,
            LogoUrl: "https://tikties-logo.s3.amazonaws.com/images/logo.png",
          }),
          notificationId: emailNotificationId,
          userId: user.userId,
          bookingId: user.bookingId,
          sendCount: emailCheck.exists ? (emailCheck.sendCount || 0) + 1 : 1,
        });
      } else {
        console.log(
          `Skipping email notification ${emailNotificationId}: sent within last hour`
        );
      }

      if (
        canSendPush &&
        pushToken &&
        typeof pushToken === "string" &&
        pushToken.length > 0
      ) {
        console.log(
          `Preparing push notification for user ${user.userId} with token ${pushToken}`
        );
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

        const eventTypeContent = {
          CANCELLED: {
            titlePrefix: "🚫 Event Cancelled",
            body: (title, date, time) =>
              `We regret to inform you that the event "${title}" has been cancelled. Originally scheduled for ${date} at ${time}.`,
          },
          RESCHEDULED: {
            titlePrefix: "📅 Event Rescheduled",
            body: (title, date, time) =>
              `The event "${title}" has been rescheduled to ${date} at ${time}. Please check the new schedule.`,
          },
          VENUE_CHANGED: {
            titlePrefix: "📍 Venue Changed",
            body: (title, date, time, location) =>
              `The venue for the event "${title}" has been changed to ${location}. It will take place on ${date} at ${time}.`,
          },
          EVENT_UPDATED: {
            titlePrefix: "🔄 Event Details Updated",
            body: (title, date, time) =>
              `The event "${title}" has been updated. It is scheduled for ${date} at ${time}. Please review the new details.`,
          },
        };

        const pushTemplate = eventTypeContent[eventType] || {
          titlePrefix: "📢 Event Update",
          body: (title, date, time) =>
            `The event "${title}" has been updated. Scheduled for ${date} at ${time}.`,
        };

        const pushMessage = {
          token: pushToken,
          notification: {
            title: `${pushTemplate.titlePrefix}: ${eventItem.EventTitle}`,
            body: pushTemplate.body(
              eventItem.EventTitle,
              formattedEventDate,
              formattedEventTime,
              eventItem.EventLocation || "No venue specified"
            ),
          },
          data: {
            event_id: eventId,
            event_type: eventType,
          },
        };

        notifications.push({
          pushMessage,
          notificationId: pushNotificationId,
          userId: user.userId,
          eventId,
          eventType: `PUSH_${eventType}`,
          bookingId: user.bookingId,
          sendCount: pushCheck.exists ? (pushCheck.sendCount || 0) + 1 : 1,
        });
      } else if (!canSendPush) {
        console.log(
          `Skipping push notification ${pushNotificationId}: sent within last hour`
        );
      } else {
        console.log(`No valid pushToken for user ${user.userId}`);
      }
    }

    if (emailDestinations.length > 0) {
      console.log(`Sending ${emailDestinations.length} emails`);
      await sendBulkEmails(emailDestinations, eventType);
      await Promise.all(
        emailDestinations.map(
          ({ notificationId, userId, bookingId, sendCount }) =>
            logNotification(
              notificationId,
              userId,
              eventId,
              `EMAIL_${eventType}`,
              bookingId,
              sendCount
            )
        )
      );
    }

    if (notifications.length > 0) {
      console.log(`Sending ${notifications.length} push notifications`);
      await sendNotifications(notifications.map((n) => n.pushMessage));
      await Promise.all(
        notifications.map(
          ({
            notificationId,
            userId,
            eventId,
            eventType,
            bookingId,
            sendCount,
          }) =>
            logNotification(
              notificationId,
              userId,
              eventId,
              eventType,
              bookingId,
              sendCount
            )
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

// Check notification log for idempotency and re-send eligibility
async function checkNotificationLog(notificationId) {
  console.log(`Checking notification log for ${notificationId}`);
  try {
    const command = new GetCommand({
      TableName: process.env.NOTIFICATION_LOGS_TABLE,
      Key: { NotificationID: notificationId },
    });
    const response = await withRetry(() => docClient.send(command));
    if (response.Item) {
      console.log(
        `Found existing notification: ${JSON.stringify(response.Item)}`
      );
      return {
        exists: true,
        timestamp: response.Item.Timestamp,
        sendCount: response.Item.SendCount || 0,
      };
    }
    return { exists: false };
  } catch (error) {
    console.error(`Error checking notification log ${notificationId}:`, error);
    return { exists: false };
  }
}

// Log notification with BookingID and SendCount
async function logNotification(
  notificationId,
  userId,
  eventId,
  eventType,
  bookingId,
  sendCount
) {
  try {
    const ttl = Math.floor(Date.now() / 1000) + 30 * 24 * 3600; // 30 days
    const command = new PutCommand({
      TableName: process.env.NOTIFICATION_LOGS_TABLE,
      Item: {
        NotificationID: notificationId,
        UserID: userId,
        EventID: eventId,
        EventType: eventType,
        BookingID: bookingId,
        Timestamp: new Date().toISOString(),
        SendCount: sendCount,
        TTL: ttl,
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
function getBody(type, event, booking_name) {
  const typeNormalized = type.toLowerCase();

  let updateMessage = "has been <strong>updated</strong>";
  let showDate = true;
  let showVenue = true;

  switch (typeNormalized) {
    case "rescheduled":
      updateMessage = "has been <strong>rescheduled</strong>";
      break;
    case "venue_changed":
      updateMessage = "venue <strong>has been changed</strong>";
      showDate = false;
      break;
    case "event_updated":
      updateMessage = "details <strong>have been updated</strong>";
      break;
    case "cancelled":
      updateMessage = "has been <strong>cancelled</strong>";
      showDate = false;
      showVenue = false;
      break;
  }

  return `
    Hello <strong>${booking_name}</strong>,<br/><br/>
    This is to inform you that the event "<strong>${
      event.EventTitle
    }</strong>" ${updateMessage}.<br/><br/>
    ${showDate ? `<strong>New Date/Time:</strong> ${event.EventDate}<br/>` : ""}
    ${
      showVenue
        ? `<strong>Venue:</strong> ${
            event.EventLocation || "No venue specified"
          }<br/>`
        : ""
    }
    <br/>
    Thank you,<br/>
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
      Destinations: destinations.map((d) => ({
        Destination: d.Destination,
        ReplacementTemplateData: d.ReplacementTemplateData,
      })),
    };

    console.log("SES params:", JSON.stringify(params, null, 2));

    const response = await withRetry(() =>
      ses.send(new SendBulkTemplatedEmailCommand(params))
    );

    console.log("SES response:", JSON.stringify(response, null, 2));
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
      console.error(
        "Error sending push notification:",
        JSON.stringify(error, null, 2)
      );
      if (error.code) {
        console.error(`FCM error code: ${error.code}`);
      }
    }
  }
}

// Function to fetch bookings using EventID
async function getBookingsForEvent(eventId) {
  try {
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

    const userIds = bookings.map((item) => item.UserId).filter((id) => !!id);

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
        UserDetails: user
          ? {
              Name: user.Name?.S,
              LastName: user.LastName?.S,
              Email: user.Email?.S,
              Phone: user.Phone?.S,
              Token: user.pushToken?.S,
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
