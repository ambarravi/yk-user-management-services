import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import admin from "firebase-admin";

// Initialize clients
const s3Client = new S3Client();
const client = new DynamoDBClient();
const docClient = DynamoDBDocumentClient.from(client);
const sesClient = new SESClient();

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
        console.log("Push notification sent successfully:", response);
        break;
      } catch (error) {
        console.error(
          `Error sending push notification to token ${message.token}:`,
          error
        );
        if (retryCount > 0) {
          console.log(
            `Retrying push notification send for token ${message.token} (${retryCount} retries left)...`
          );
          retryCount--;
        } else {
          throw new Error(
            `Failed to send push notification to token ${message.token}: ${error.message}`
          );
        }
      }
    }
  }
};

// Send emails via SES with retry
const sendEmails = async (emails) => {
  for (const email of emails) {
    let retryCount = RETRY_COUNT;
    while (retryCount >= 0) {
      try {
        const command = new SendEmailCommand({
          Source: process.env.SES_SENDER_EMAIL,
          Destination: {
            ToAddresses: [email.to],
          },
          Message: {
            Subject: {
              Data: email.subject,
            },
            Body: {
              Text: {
                Data: email.body,
              },
            },
          },
        });
        const response = await sesClient.send(command);
        console.log(`Email sent successfully to ${email.to}:`, response);
        break;
      } catch (error) {
        console.error(`Error sending email to ${email.to}:`, error);
        if (retryCount > 0) {
          console.log(
            `Retrying email send for ${email.to} (${retryCount} retries left)...`
          );
          retryCount--;
        } else {
          throw new Error(
            `Failed to send email to ${email.to}: ${error.message}`
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
    const pushMessages = [];
    const emails = [];
    const logs = [];
    const pushReminderType = "event_cancelled_push";
    const emailReminderType = "event_cancelled_email";

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

      // Format EventDate for notification and email (in IST)
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

        // Check push and email notification logs
        const pushNotificationId = `${bookingId}_${pushReminderType}`;
        const emailNotificationId = `${bookingId}_${emailReminderType}`;

        const [pushSent, emailSent] = await Promise.all([
          checkNotificationLog(pushNotificationId),
          checkNotificationLog(emailNotificationId),
        ]);

        if (pushSent && emailSent) {
          console.log(
            `Skipping notification ${pushNotificationId} and ${emailNotificationId}: already sent`
          );
          continue;
        }

        // Fetch user details and push token
        const [user, pushToken] = await Promise.all([
          getUserDetails(userId),
          getPushToken(userId),
        ]);

        if (!user) {
          console.warn(`Skipping booking ${bookingId}: missing user data`);
          continue;
        }

        const userName = user.FirstName || user.LastName || "Dear";

        // Prepare push notification if not already sent
        if (!pushSent && pushToken) {
          const pushMessage = {
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
          pushMessages.push(pushMessage);
          logs.push({
            notificationId: pushNotificationId,
            bookingId,
            userId,
            reminderType: pushReminderType,
          });
        }

        // Prepare email if not already sent and email exists
        if (!emailSent && user.Email) {
          const email = {
            to: user.Email,
            subject: `Event Cancelled: ${eventTitle}`,
            body: `Dear ${userName},\n\nWe regret to inform you that the event "${eventTitle}" scheduled for ${formattedEventDate} has been cancelled. Please contact our support team for more details or assistance.\n\nBest regards,\nThe Tikto Team`,
          };
          emails.push(email);
          logs.push({
            notificationId: emailNotificationId,
            bookingId,
            userId,
            reminderType: emailReminderType,
          });
        }

        if (!pushToken && !user.Email) {
          console.warn(
            `Skipping booking ${bookingId}: missing push token and email`
          );
        }
      }
    }

    // Send push notifications and emails, then log them
    if (pushMessages.length > 0 || emails.length > 0) {
      console.log(
        `Sending ${pushMessages.length} push notifications and ${emails.length} emails`
      );
      await Promise.all([
        pushMessages.length > 0
          ? sendNotifications(pushMessages)
          : Promise.resolve(),
        emails.length > 0 ? sendEmails(emails) : Promise.resolve(),
      ]);
      await Promise.all(
        logs.map(({ notificationId, bookingId, userId, reminderType }) =>
          logNotification(notificationId, bookingId, userId, reminderType)
        )
      );
    }

    return {
      statusCode: 200,
      body: `Processed ${pushMessages.length} push notifications and ${emails.length} emails`,
    };
  } catch (error) {
    console.error("Handler error:", error);
    throw new Error(`Lambda processing failed: ${error.message}`);
  }
};
