import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  QueryCommand,
  GetCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import { Expo } from "expo-server-sdk";
import { setTimeout } from "timers/promises";

// Initialize AWS and Expo clients
const dynamoDBClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoDBClient);
const expo = new Expo();

// Configuration
const BATCH_SIZE = 100; // Expo recommends max 100 notifications per request
const BATCH_DELAY_MS = 200; // Delay between batches to avoid rate limiting (600/sec = ~1.67ms per notification)

// Utility to get current UTC time and format for DynamoDB
const getTimeWindow = (hoursOffset) => {
  const now = new Date();
  const targetTime = new Date(now.getTime() + hoursOffset * 60 * 60 * 1000);
  const startTime = new Date(targetTime.getTime() - 5 * 60 * 1000)
    .toISOString()
    .slice(0, 16);
  const endTime = new Date(targetTime.getTime() + 5 * 60 * 1000)
    .toISOString()
    .slice(0, 16);
  return { startTime, endTime };
};

// Check if notification was already sent
const checkNotificationLog = async (notificationId) => {
  const command = new GetCommand({
    TableName: "NotificationLogs",
    Key: { NotificationID: notificationId },
  });
  const response = await docClient.send(command);
  return !!response.Item;
};

// Log sent notification
const logNotification = async (
  notificationId,
  bookingId,
  userId,
  reminderType
) => {
  const command = new PutCommand({
    TableName: "NotificationLogs",
    Item: {
      NotificationID: notificationId,
      BookingID: bookingId,
      UserID: userId,
      ReminderType: reminderType,
      SentAt: Math.floor(Date.now() / 1000),
    },
  });
  await docClient.send(command);
};

// Fetch event details
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

// Fetch user details
const getUserDetails = async (userId) => {
  const command = new GetCommand({
    TableName: "UserTable",
    Key: { UserID: userId },
  });
  const response = await docClient.send(command);
  return response.Item;
};

// Fetch push token
const getPushToken = async (userId) => {
  const command = new GetCommand({
    TableName: "TiktoPushTokens",
    Key: { userId },
  });
  const response = await docClient.send(command);
  return response.Item?.token;
};

// Send batched notifications
const sendNotifications = async (messages) => {
  const chunks = [];
  for (let i = 0; i < messages.length; i += BATCH_SIZE) {
    chunks.push(messages.slice(i, i + BATCH_SIZE));
  }

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    try {
      const tickets = await expo.sendPushNotificationsAsync(chunk);
      console.log(`Batch ${i + 1}/${chunks.length} sent:`, tickets);

      // Handle errors (e.g., invalid tokens)
      for (const ticket of tickets) {
        if (ticket.status === "error") {
          console.error("Notification error:", ticket.message, ticket.details);
          // Optionally remove invalid tokens from TiktoPushTokens
        }
      }
    } catch (error) {
      console.error(`Error sending batch ${i + 1}:`, error);
    }
    if (i < chunks.length - 1) {
      await setTimeout(BATCH_DELAY_MS); // Delay to avoid rate limiting
    }
  }
};

// Main Lambda handler
export const handler = async (event) => {
  try {
    const reminderType = event.reminder_type || "6_hour";
    const hoursOffset = reminderType === "6_hour" ? 6 : 1;
    const { startTime, endTime } = getTimeWindow(hoursOffset);

    console.log(
      `Processing ${reminderType} reminders for events between ${startTime} and ${endTime}`
    );

    // Query bookings for the time window
    const queryCommand = new QueryCommand({
      TableName: "BookingDetails",
      IndexName: "EventDateIndex",
      KeyConditionExpression: "EventDate BETWEEN :start AND :end",
      FilterExpression: "BookingStatus = :status",
      ExpressionAttributeValues: {
        ":start": startTime,
        ":end": endTime,
        ":status": "Completed",
      },
    });

    const bookings = (await docClient.send(queryCommand)).Items || [];
    console.log(`Found ${bookings.length} bookings`);

    const messages = [];
    const logs = [];

    for (const booking of bookings) {
      const {
        BookingID: bookingId,
        EventID: eventId,
        UserId: userId,
      } = booking;
      const notificationId = `${bookingId}_${reminderType}`;

      // Skip if notification was already sent
      if (await checkNotificationLog(notificationId)) {
        console.log(`Skipping notification ${notificationId}: already sent`);
        continue;
      }

      // Fetch event, user, and push token
      const [event, user, pushToken] = await Promise.all([
        getEventDetails(eventId),
        getUserDetails(userId),
        getPushToken(userId),
      ]);

      if (!event || !user || !pushToken || !Expo.isExpoPushToken(pushToken)) {
        console.warn(
          `Skipping booking ${bookingId}: missing data or invalid token`
        );
        continue;
      }

      // Construct notification
      const message = {
        to: pushToken,
        title: `Upcoming Event: ${event.EventTitle}`,
        body: `Your event starts in ${reminderType.replace("_", " ")} at ${
          event.EventDate
        }!`,
        data: { booking_id: bookingId, event_id: eventId },
      };

      messages.push(message);
      logs.push({ notificationId, bookingId, userId, reminderType });
    }

    // Send notifications in batches
    if (messages.length > 0) {
      console.log(`Sending ${messages.length} notifications`);
      await sendNotifications(messages);

      // Log notifications
      await Promise.all(
        logs.map(({ notificationId, bookingId, userId, reminderType }) =>
          logNotification(notificationId, bookingId, userId, reminderType)
        )
      );
    } else {
      console.log("No notifications to send");
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: `${messages.length} notifications processed`,
      }),
    };
  } catch (error) {
    console.error("Error:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ message: "Internal server error" }),
    };
  }
};
