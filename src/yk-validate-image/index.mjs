import {
  RekognitionClient,
  DetectModerationLabelsCommand,
} from "@aws-sdk/client-rekognition";
import { S3Client, DeleteObjectCommand } from "@aws-sdk/client-s3";
import {
  DynamoDBClient,
  UpdateItemCommand,
  QueryCommand,
} from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { v4 as uuidv4 } from "uuid";

const rekognition = new RekognitionClient({});
const s3 = new S3Client({});
const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);
const ses = new SESClient({});

const LOGO_URL = "https://tikties-logo.s3.amazonaws.com/images/logo.png";
const EMAIL_LIMIT_PER_HOUR = 5;
const ONE_HOUR_MS = 60 * 60 * 1000;
const MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 100;

const BLOCKED_LABELS = [
  "explicit nudity",
  "suggestive",
  "partial nudity",
  "female swimwear or underwear",
  "male swimwear or underwear",
  "sexual situations",
  "graphic violence",
  "violence",
  "revealing clothes",
  "non-explicit nudity",
  "partially exposed female breast",
];

// Custom error classes
class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
  }
}

class RateLimitError extends Error {
  constructor(message) {
    super(message);
    this.name = "RateLimitError";
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const retryOperation = async (operation, maxRetries = MAX_RETRIES) => {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === maxRetries) break;
      const delay = BASE_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
      console.log(`Retry attempt ${attempt} failed. Retrying after ${delay}ms`);
      await sleep(delay);
    }
  }
  throw lastError;
};

const checkEmailRateLimit = async (eventId, organizerId, requestId) => {
  const notificationIdPrefix = `EMAIL_${eventId}_${organizerId}_UNDER_REVIEW`;
  let emailCount = 0;

  try {
    // Check recent notifications within the last hour
    for (let i = 0; i < EMAIL_LIMIT_PER_HOUR; i++) {
      const notificationId = `${notificationIdPrefix}_${i}`;
      const response = await retryOperation(() =>
        docClient.send(
          new GetCommand({
            TableName: "NotificationLogs",
            Key: { NotificationID: notificationId },
          })
        )
      );

      if (response.Item) {
        const timestamp = response.Item.Timestamp;
        if (
          timestamp &&
          (new Date().getTime() - new Date(timestamp).getTime()) / 1000 <= 3600
        ) {
          emailCount += 1;
        }
      }
    }

    console.log({
      requestId,
      eventId,
      organizerId,
      emailCount,
      message: "Email rate limit check completed",
    });

    if (emailCount >= EMAIL_LIMIT_PER_HOUR) {
      throw new RateLimitError(
        `Email limit of ${EMAIL_LIMIT_PER_HOUR} per hour exceeded for EventID: ${eventId}`
      );
    }

    return emailCount;
  } catch (error) {
    console.error({
      requestId,
      eventId,
      error: error.message,
      message: "Error checking rate limit",
    });
    throw error;
  }
};

const checkIdempotency = async (notificationId, requestId) => {
  try {
    const response = await retryOperation(() =>
      docClient.send(
        new GetCommand({
          TableName: "NotificationLogs",
          Key: { NotificationID: notificationId },
        })
      )
    );
    const exists = !!response.Item;
    console.log({
      requestId,
      notificationId,
      exists,
      message: "Idempotency check completed",
    });
    return {
      exists,
      timestamp: response.Item?.Timestamp,
      sendCount: response.Item?.SendCount || 0,
    };
  } catch (error) {
    console.error({
      requestId,
      notificationId,
      error: error.message,
      message: "Error checking idempotency",
    });
    return { exists: false };
  }
};

export const handler = async (event) => {
  const errors = [];

  for (const record of event.Records) {
    const requestId = uuidv4();
    try {
      const bucket = record.s3.bucket.name;
      const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));
      console.log({ requestId, bucket, key, message: "Processing image" });

      // Extract EventID
      const match = key.match(/event-images\/(EVT-[^/]+)\//);
      const readableEventID = match?.[1];
      if (!readableEventID) {
        throw new ValidationError("EventID not found in key");
      }

      // Check idempotency
      const notificationID = `EMAIL_${readableEventID}_UNDER_REVIEW_${requestId}`;
      const idempotencyCheck = await checkIdempotency(
        notificationID,
        requestId
      );
      if (idempotencyCheck.exists) {
        console.log({
          requestId,
          notificationID,
          message: "Duplicate request detected, skipping",
        });
        continue;
      }

      // Rekognition check with retry
      const moderationResult = await retryOperation(() =>
        rekognition.send(
          new DetectModerationLabelsCommand({
            Image: { S3Object: { Bucket: bucket, Name: key } },
            MinConfidence: 80,
          })
        )
      );

      console.log({
        requestId,
        moderationLabels: moderationResult.ModerationLabels,
      });

      const flagged = moderationResult.ModerationLabels?.some((label) => {
        const name = label.Name?.toLowerCase();
        const parent = label.ParentName?.toLowerCase();
        return BLOCKED_LABELS.includes(name) || BLOCKED_LABELS.includes(parent);
      });

      if (!flagged) {
        console.log({ requestId, key, message: "Image passed moderation" });
        continue;
      }

      // Delete image with retry
      await retryOperation(() =>
        s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
      );
      console.log({
        requestId,
        key,
        message: "Image deleted due to violation",
      });

      // Get EventDetails with retry
      const eventDetailsRes = await retryOperation(() =>
        ddbClient.send(
          new QueryCommand({
            TableName: "EventDetails",
            IndexName: "ReadableEventID-index",
            KeyConditionExpression: "ReadableEventID = :eid",
            ExpressionAttributeValues: {
              ":eid": { S: readableEventID },
            },
          })
        )
      );

      const eventItem = eventDetailsRes.Items?.[0];
      if (!eventItem) {
        throw new ValidationError("Event not found");
      }

      const eventId = eventItem.EventID.S;
      const eventTitle = eventItem.EventTitle.S;
      const organizerId = eventItem.OrgID.S;

      // Check email rate limit
      await checkEmailRateLimit(eventId, organizerId, requestId);

      // Update event status with retry
      await retryOperation(() =>
        ddbClient.send(
          new UpdateItemCommand({
            TableName: "EventDetails",
            Key: { EventID: { S: eventId } },
            UpdateExpression: "SET #s = :r",
            ExpressionAttributeNames: { "#s": "EventStatus" },
            ExpressionAttributeValues: { ":r": { S: "UnderReview" } },
            ConditionExpression: "attribute_exists(EventID)",
          })
        )
      );

      // Get Organizer Email with retry
      const orgRes = await retryOperation(() =>
        ddbClient.send(
          new QueryCommand({
            TableName: "Organizer",
            KeyConditionExpression: "OrganizerID = :oid",
            ExpressionAttributeValues: {
              ":oid": { S: organizerId },
            },
          })
        )
      );

      const contactEmail = orgRes.Items?.[0]?.contactEmail?.S;
      if (!contactEmail) {
        throw new ValidationError("Organizer contactEmail not found");
      }

      // Send Email with retry
      const subject = `Violation of Policy - Event: "${eventTitle}" is Under Review`;
      const htmlBody = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body><div style="background:#fff;padding:30px;font-family:Arial;max-width:600px;margin:auto;border-radius:8px;box-shadow:0 2px 6px rgba(0,0,0,0.1)"><img src='${LOGO_URL}' style="max-width:120px;display:block;margin:0 auto 20px"/><h2 style="text-align:center">${subject}</h2><p>This is to inform you that your application to host event <strong>${eventTitle}</strong> is under review because an uploaded image was rejected by our system. Your event is currently marked <strong>Under Review</strong>.</p><div style="margin-top:40px;font-size:12px;color:#999;text-align:center">You are receiving this email as part of your event participation.<br/>For support, contact us at support@tikties.com</div></div></body></html>`;

      await retryOperation(() =>
        ses.send(
          new SendEmailCommand({
            Destination: {
              ToAddresses: [contactEmail],
              CcAddresses: ["support@tikties.com"],
              BccAddresses: ["ravi.ambar@gmail.com"],
            },
            Message: {
              Subject: { Data: subject },
              Body: {
                Html: { Data: htmlBody },
              },
            },
            Source: "support@tikties.com",
          })
        )
      );

      // Log Notification with retry
      const timestamp = new Date().toISOString();
      const ttl = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;

      await retryOperation(() =>
        docClient.send(
          new PutCommand({
            TableName: "NotificationLogs",
            Item: {
              NotificationID: notificationID,
              BookingID: "",
              EventID: eventId,
              EventType: "EMAIL_UNDER_REVIEW",
              SendCount: 1,
              Timestamp: timestamp,
              TTL: ttl,
              UserID: organizerId,
            },
            ConditionExpression: "attribute_not_exists(NotificationID)",
          })
        )
      );

      console.log({
        requestId,
        notificationID,
        message: "Processing completed successfully",
      });
    } catch (error) {
      if (error instanceof RateLimitError) {
        console.warn({
          requestId,
          error: error.message,
          message: "Rate limit exceeded, skipping email",
        });
        continue;
      }
      console.error({
        requestId,
        error: error.message,
        stack: error.stack,
        message: "Error processing image",
      });
      errors.push({ key: record.s3.object.key, error: error.message });
    }
  }

  if (errors.length > 0) {
    console.error({ errors, message: "Some records failed processing" });
    throw new Error(`Failed to process ${errors.length} records`);
  }

  return { statusCode: 200 };
};
