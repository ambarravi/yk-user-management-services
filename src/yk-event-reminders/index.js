import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import admin from "firebase-admin";

// Initialize S3 client
const s3Client = new S3Client();

const client = new DynamoDBClient();
const docClient = DynamoDBDocumentClient.from(client);

const getTimeWindow = (hoursOffset) => {
  const now = new Date();
  const istOffsetMs = 5.5 * 60 * 60 * 1000; // IST = UTC + 5.5 hrs
  const nowIST = new Date(now.getTime() + istOffsetMs);

  const targetTime = new Date(nowIST.getTime() + hoursOffset * 60 * 60 * 1000);
  const startTime = new Date(
    targetTime.getTime() - 30 * 60 * 1000
  ).toISOString();
  const endTime = new Date(targetTime.getTime() + 30 * 60 * 1000).toISOString();

  return { startTime, endTime };
};

const getBookings = async (reminderType) => {
  const hoursOffset = reminderType === "6_hour" ? 6 : 1;
  const { startTime, endTime } = getTimeWindow(hoursOffset);

  const start = startTime.slice(0, 16);
  const end = endTime.slice(0, 16);

  console.log(
    `Querying BookingStatus = "Completed" AND EventDate BETWEEN ${start} AND ${end}`
  );

  try {
    const queryCommand = new QueryCommand({
      TableName: "BookingDetails",
      IndexName: "BookingStatus-index",
      KeyConditionExpression:
        "BookingStatus = :status AND EventDate BETWEEN :start AND :end",
      ExpressionAttributeValues: {
        ":status": "Completed",
        ":start": start,
        ":end": end,
      },
    });

    const response = await docClient.send(queryCommand);
    console.log(`Found ${response.Items?.length || 0} bookings`);
    return response.Items || [];
  } catch (error) {
    console.error("Error querying bookings:", error);
    return [];
  }
};

const getEventDetails = async (eventId) => {
  try {
    const command = new GetCommand({
      TableName: "EventDetails",
      Key: { EventID: eventId },
    });
    const response = await docClient.send(command);
    if (response.Item && response.Item.EventStatus === "Published") {
      return response.Item;
    }
    return null;
  } catch (error) {
    console.error(`Error fetching event ${eventId}:`, error);
    return null;
  }
};

const getUserDetails = async (userId) => {
  try {
    const command = new GetCommand({
      TableName: "UsersTable",
      Key: { UserID: userId },
    });
    const response = await docClient.send(command);
    return response.Item;
  } catch (error) {
    console.error(`Error fetching user ${userId}:`, error);
    return null;
  }
};

const getPushToken = async (userId) => {
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
    return null;
  }
};

const checkNotificationLog = async (notificationId) => {
  try {
    const command = new GetCommand({
      TableName: "NotificationLogs",
      Key: { NotificationID: notificationId },
    });
    const response = await docClient.send(command);
    return !!response.Item;
  } catch (error) {
    console.error(`Error checking notification log ${notificationId}:`, error);
    return false;
  }
};

const logNotification = async (
  notificationId,
  bookingId,
  userId,
  reminderType
) => {
  try {
    const command = new PutCommand({
      TableName: "NotificationLogs",
      Item: {
        NotificationID: notificationId,
        BookingID: bookingId,
        UserID: userId,
        ReminderType: reminderType,
        Timestamp: new Date().toISOString(),
      },
    });
    await docClient.send(command);
  } catch (error) {
    console.error(`Error logging notification ${notificationId}:`, error);
  }
};

// Send notifications via FCM (Firebase Cloud Messaging)
const sendNotifications = async (messages) => {
  for (const message of messages) {
    try {
      const response = await admin.messaging().send(message);
      console.log("Notification sent successfully:", response);
    } catch (error) {
      console.error("Error sending notification:", error);
    }
  }
};

export const handler = async (event) => {
  // Retrieve and parse the service account JSON from S3
  let serviceAccount;
  try {
    const command = new GetObjectCommand({
      Bucket: "tiktie-notifications",
      Key: "tiktie-firebase-adminsdk-fbsvc-7c2642a541.json",
    });
    const response = await s3Client.send(command);
    const serviceAccountData = await response.Body.transformToString();
    serviceAccount = JSON.parse(serviceAccountData);
  } catch (error) {
    console.error(
      "Failed to retrieve or parse service account from S3:",
      error
    );
    return {
      statusCode: 500,
      body: "Failed to initialize Firebase: Unable to retrieve service account",
    };
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

  const reminderType = event.reminder_type;
  if (!["6_hour", "1_hour"].includes(reminderType)) {
    console.error("Invalid reminder_type:", reminderType);
    return { statusCode: 400, body: "Invalid reminder_type" };
  }

  try {
    const bookings = await getBookings(reminderType);
    console.log(`Found ${bookings.length} bookings for ${reminderType}`);

    const messages = [];
    const logs = [];
    for (const booking of bookings) {
      const {
        BookingID: bookingId,
        EventID: eventId,
        UserId: userId,
      } = booking;
      const notificationId = `${bookingId}_${reminderType}`;

      if (await checkNotificationLog(notificationId)) {
        console.log(`Skipping notification ${notificationId}: already sent`);
        continue;
      }

      const [event, user, pushToken] = await Promise.all([
        getEventDetails(eventId),
        getUserDetails(userId),
        getPushToken(userId),
      ]);

      if (!event || !user || !pushToken) {
        console.warn(`Skipping booking ${bookingId}: missing data`);
        continue;
      }

      const eventDateTime = new Date(event.EventDate || event.EventDate.S);

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
          title: `📢 Upcoming Event: ${event.EventTitle}`,
          body: `Get ready! Your event is happening on ${formattedEventDate} at ${formattedEventTime}.`,
        },
        data: {
          booking_id: bookingId,
          event_id: eventId,
          screen: "ManageTicketScreen",
        },
      };

      messages.push(message);
      logs.push({ notificationId, bookingId, userId, reminderType });
    }

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
    return { statusCode: 500, body: "Internal server error" };
  }
};
