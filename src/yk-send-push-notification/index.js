import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import admin from "firebase-admin";

// Initialize S3 and DynamoDB clients
const s3Client = new S3Client();
const client = new DynamoDBClient();
const docClient = DynamoDBDocumentClient.from(client);

// Get retry count from environment variable (default to 1)
const RETRY_COUNT = parseInt(process.env.RETRY_COUNT, 10) || 1;

// Get current time in IST
const getCurrentIST = () => {
  const now = new Date();
  const istOffsetMs = 5.5 * 60 * 60 * 1000; // IST = UTC + 5.5 hrs
  return new Date(now.getTime() + istOffsetMs);
};

// Fetch bookings for a given EventID with retry
const getBookingsByEvent = async (eventId, retryCount = RETRY_COUNT) => {
  try {
    const queryCommand = new QueryCommand({
      TableName: "BookingDetails",
      IndexName: "EventID-index",
      KeyConditionExpression: "EventID = :eventId",
      ExpressionAttributeValues: {
        ":eventId": eventId,
      },
    });

    const response = await docClient.send(queryCommand);
    console.log(
      `Found ${response.Items?.length || 0} bookings for EventID ${eventId}`
    );
    return response.Items || [];
  } catch (error) {
    console.error(`Error querying bookings for EventID ${eventId}:`, error);
    if (retryCount > 0) {
      console.log(
        `Retrying getBookingsByEvent for EventID ${eventId} (${retryCount} retries left)...`
      );
      return getBookingsByEvent(eventId, retryCount - 1);
    }
    throw new Error(
      `Failed to query bookings for EventID ${eventId}: ${error.message}`
    );
  }
};

// Fetch event details from EventDetails with retry
const getEventDetails = async (eventId, retryCount = RETRY_COUNT) => {
  try {
    const command = new GetCommand({
      TableName: "EventDetails",
      Key: { EventID: eventId },
    });
    const response = await docClient.send(command);
    return response.Item || null;
  } catch (error) {
    console.error(`Error fetching event ${eventId}:`, error);
    if (retryCount > 0) {
      console.log(
        `Retrying getEventDetails for EventID ${eventId} (${retryCount} retries left)...`
      );
      return getEventDetails(eventId, retryCount - 1);
    }
    throw new Error(`Failed to fetch event ${eventId}: ${error.message}`);
  }
};

// Fetch user details from UsersTable with retry
const getUserDetails = async (userId, retryCount = RETRY_COUNT) => {
  try {
    const command = new GetCommand({
      TableName: "UsersTable",
      Key: { UserID: userId },
    });
    const response = await docClient.send(command);
    return response.Item;
  } catch (error) {
    console.error(`Error fetching user ${userId}:`, error);
    if (retryCount > 0) {
      console.log(
        `Retrying getUserDetails for UserID ${userId} (${retryCount} retries left)...`
      );
      return getUserDetails(userId, retryCount - 1);
    }
    throw new Error(`Failed to fetch user ${userId}: ${error.message}`);
  }
};

// Fetch push token from TiktoPushTokens with retry
const getPushToken = async (userId, retryCount = RETRY_COUNT) => {
  try {
    const command = new QueryCommand({
      TableName: "TiktoPushTokens",
      KeyConditionExpression: "userId = :uid",
      ExpressionAttributeValues: {
        ":uid": userId,
      },
      Limit: 1,
      ScanIndexForward: false,
    });

    const response = await docClient.send(command);
    const token = response.Items?.[0]?.token;

    if (!token) {
      console.warn(`No push token found for user ${userId}`);
    }

    return token;
  } catch (error) {
    console.error(`Error fetching push token for user ${userId}:`, error);
    if (retryCount > 0) {
      console.log(
        `Retrying getPushToken for UserID ${userId} (${retryCount} retries left)...`
      );
      return getPushToken(userId, retryCount - 1);
    }
    throw new Error(
      `Failed to fetch push token for user ${userId}: ${error.message}`
    );
  }
};

// Check if notification was already sent with retry
const checkNotificationLog = async (
  notificationId,
  retryCount = RETRY_COUNT
) => {
  try {
    const command = new GetCommand({
      TableName: "NotificationLogs",
      Key: { NotificationID: notificationId },
    });
    const response = await docClient.send(command);
    return !!response.Item;
  } catch (error) {
    console.error(`Error checking notification log ${notificationId}:`, error);
    if (retryCount > 0) {
      console.log(
        `Retrying checkNotificationLog for NotificationID ${notificationId} (${retryCount} retries left)...`
      );
      return checkNotificationLog(notificationId, retryCount - 1);
    }
    throw new Error(
      `Failed to check notification log ${notificationId}: ${error.message}`
    );
  }
};

// Log notification to NotificationLogs with retry
const logNotification = async (
  notificationId,
  bookingId,
  userId,
  reminderType,
  retryCount = RETRY_COUNT
) => {
  try {
    const command = new PutCommand({
      TableName: "NotificationLogs",
      Item: {
        NotificationID: notificationId,
        BookingID: bookingId,
        UserID: userId,
        ReminderType: reminderType,
        Timestamp: getCurrentIST().toISOString(),
      },
    });
    await docClient.send(command);
  } catch (error) {
    console.error(`Error logging notification ${notificationId}:`, error);
    if (retryCount > 0) {
      console.log(
        `Retrying logNotification for NotificationID ${notificationId} (${retryCount} retries left)...`
      );
      return logNotification(
        notificationId,
        bookingId,
        userId,
        reminderType,
        retryCount - 1
      );
    }
    throw new Error(
      `Failed to log notification ${notificationId}: ${error.message}`
    );
  }
};

// Send notifications via FCM with retry
const sendNotifications = async (messages) => {
  for (const message of messages) {
    let retryCount = RETRY_COUNT;
    while (retryCount >= 0) {
      try {
        const response = await admin.messaging().send(message);
        console.log("Notification sent successfully:", response);
        break;
      } catch (error) {
        console.error(
          `Error sending notification to token ${message.token}:`,
          error
        );
        if (retryCount > 0) {
          console.log(
            `Retrying notification send for token ${message.token} (${retryCount} retries left)...`
          );
          retryCount--;
        } else {
          throw new Error(
            `Failed to send notification to token ${message.token}: ${error.message}`
          );
        }
      }
    }
  }
};

export const handler = async (event) => {
  // Retrieve and parse the service account JSON from S3
  let serviceAccount;
  try {
    const command = new GetObjectCommand({
      Bucket: "tiktie-notifications",
      Key: process.env.S3_FCM_KEY,
    });
    const response = await s3Client.send(command);
    const serviceAccountData = await response.Body.transformToString();
    serviceAccount = JSON.parse(serviceAccountData);
    console.log("Service account parsed:", {
      projectId: serviceAccount.project_id,
      clientEmail: serviceAccount.client_email,
      privateKey: serviceAccount.private_key ? "Present" : "Missing",
      privateKeyId: serviceAccount.private_key_id,
    });
  } catch (error) {
    console.error(
      "Failed to retrieve or parse service account from S3:",
      error
    );
    throw new Error(`Failed to initialize Firebase: ${error.message}`);
  }

  // Initialize Firebase Admin SDK (only if not already initialized)
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: serviceAccount.project_id,
        clientEmail: serviceAccount.client_email,
        privateKey: serviceAccount.private_key,
      }),
    });
  }

  try {
    const messages = [];
    const logs = [];
    const reminderType = "event_cancelled";

    // Process each SQS record
    for (const record of event.Records) {
      const payload = JSON.parse(record.body);
      const {
        EventID: eventId,
        OrgID: orgId,
        EventStatus: eventStatus,
      } = payload;

      // Log original payload for DLQ debugging
      console.log("Processing SQS payload:", JSON.stringify(payload));

      // Validate event status
      if (eventStatus !== "Cancelled") {
        console.log(
          `Skipping EventID ${eventId}: EventStatus is ${eventStatus}, not Cancelled`
        );
        continue;
      }

      // Fetch event details to get EventTitle and EventDate
      const eventDetails = await getEventDetails(eventId);
      if (!eventDetails) {
        console.warn(`Skipping EventID ${eventId}: Event details not found`);
        continue;
      }
      const { EventTitle: eventTitle, EventDate: eventDate } = eventDetails;

      // Format EventDate for notification (in IST)
      const eventDateTime = new Date(eventDate);
      const formattedEventDate = eventDateTime.toLocaleDateString("en-IN", {
        day: "numeric",
        month: "long",
        year: "numeric",
        timeZone: "Asia/Kolkata",
      });

      // Fetch bookings for the event
      const bookings = await getBookingsByEvent(eventId);
      console.log(
        `Processing ${bookings.length} bookings for cancelled EventID ${eventId}`
      );

      for (const booking of bookings) {
        const { BookingID: bookingId, UserId: userId } = booking;
        const notificationId = `${bookingId}_${reminderType}`;

        // Check if notification was already sent
        if (await checkNotificationLog(notificationId)) {
          console.log(`Skipping notification ${notificationId}: already sent`);
          continue;
        }

        // Fetch user details and push token
        const [user, pushToken] = await Promise.all([
          getUserDetails(userId),
          getPushToken(userId),
        ]);

        if (!user || !pushToken) {
          console.warn(
            `Skipping booking ${bookingId}: missing user or push token`
          );
          continue;
        }

        // Prepare notification message
        const userName = user.FirstName || user.LastName || "Dear";
        const message = {
          token: pushToken,
          notification: {
            title: `❌ ${userName}, Event Cancelled`,
            body: `We regret to inform you that the event "${eventTitle}" scheduled for ${formattedEventDate} has been cancelled. Please contact support for more details.`,
          },
          data: {
            booking_id: bookingId,
            event_id: eventId,
            org_id: orgId,
            screen: "ManageTicketScreen",
          },
        };

        messages.push(message);
        logs.push({ notificationId, bookingId, userId, reminderType });
      }
    }

    // Send notifications and log them
    if (messages.length > 0) {
      console.log(`Sending ${messages.length} notifications`);
      await sendNotifications(messages);
      await Promise.all(
        logs.map(({ notificationId, bookingId, userId, reminderType }) =>
          logNotification(notificationId, bookingId, userId, reminderType)
        )
      );
    }

    return {
      statusCode: 200,
      body: `Processed ${messages.length} notifications`,
    };
  } catch (error) {
    console.error("Handler error:", error);
    throw new Error(`Lambda processing failed: ${error.message}`);
  }
};
