import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import { Expo } from "expo-server-sdk";

const client = new DynamoDBClient();
const docClient = DynamoDBDocumentClient.from(client);
const expo = new Expo();

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

  // DynamoDB ISO string format precision for sort keys (e.g. "2025-04-16T10:00")
  const start = startTime.slice(0, 16);
  const end = endTime.slice(0, 16);

  console.log(
    `Querying BookingStatus = "Completed" AND EventDate BETWEEN ${start} AND ${end}`
  );

  try {
    const queryCommand = new QueryCommand({
      TableName: "BookingDetails",
      IndexName: "BookingStatus-index", // Use your actual GSI name
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
      TableName: "UserTable",
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
    const command = new GetCommand({
      TableName: "TiktoPushTokens",
      Key: { userId },
    });
    const response = await docClient.send(command);
    return response.Item?.token;
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

const sendNotifications = async (messages) => {
  const chunks = expo.chunkPushNotifications(messages);
  for (const chunk of chunks) {
    try {
      const tickets = await expo.sendPushNotificationsAsync(chunk);
      for (const ticket of tickets) {
        if (ticket.status === "error") {
          console.error("Notification error:", ticket.message, ticket.details);
          if (ticket.details?.error === "DeviceNotRegistered") {
            console.log("Consider removing invalid push token");
          }
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    } catch (error) {
      console.error("Error sending notifications:", error);
    }
  }
};

export const handler = async (event) => {
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
      console.log("userId", userId);
      console.log("bookingId", bookingId);
      console.log("eventId", eventId);
      const [event, user, pushToken] = await Promise.all([
        getEventDetails(eventId),
        getUserDetails(userId),
        getPushToken(userId),
      ]);

      if (!event || !user || !pushToken || !Expo.isExpoPushToken(pushToken)) {
        console.warn(
          `Skipping booking ${bookingId}: unpublished event or missing data`
        );
        continue;
      }

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
