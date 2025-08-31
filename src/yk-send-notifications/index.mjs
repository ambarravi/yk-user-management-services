// index.mjs
import { SQSClient, DeleteMessageCommand } from "@aws-sdk/client-sqs";
import {
  DynamoDBClient,
  PutItemCommand,
  QueryCommand,
} from "@aws-sdk/client-dynamodb";
import { v4 as uuidv4 } from "uuid";

const sqsClient = new SQSClient({ region: process.env.AWS_REGION });
const dynamoDBClient = new DynamoDBClient({ region: process.env.AWS_REGION });

const QUEUE_URL = process.env.EVENT_PUBLISH_QUEUE_URL;
const NOTIFICATION_TABLE = process.env.NOTIFICATION_TABLE || "NotificationLogs";
const EXPO_API_URL = "https://exp.host/--/api/v2/push/send";
const EXPO_ACCESS_TOKEN = process.env.EXPO_ACCESS_TOKEN;
const BATCH_SIZE = 100; // Expo's max batch size
const MAX_RETRIES = 3;

export const handler = async (event) => {
  console.log("Received SQS event:", JSON.stringify(event, null, 2));
  const batchItemFailures = [];

  await Promise.all(
    event.Records.map(async (record) => {
      const notificationId = uuidv4();
      let EventID, OrgID, DateTime; // For failure logging

      try {
        const {
          EventID: evtId,
          OrgID: orgId,
          EventTitle,
          DateTime: dt,
          CustomMessage,
        } = JSON.parse(record.body.eventDetails);
        EventID = evtId;
        OrgID = orgId;
        DateTime = dt;

        if (!EventID || !OrgID || !EventTitle || !DateTime || !CustomMessage) {
          throw new Error("Missing required fields in SQS message");
        }

        // Fetch followers with pagination
        const followers = await getFollowers(OrgID);
        if (!followers || followers.length === 0) {
          throw new Error(`No followers found for OrgID: ${OrgID}`);
        }
        console.log(
          `Fetched ${followers.length} followers for OrgID: ${OrgID}`
        );

        // Batch followers into groups of 100
        const batches = chunkArray(followers, BATCH_SIZE);
        const sendPromises = batches.map(async (batch, batchIndex) => {
          const payload = {
            to: batch.map((follower) => follower.pushToken),
            title: EventTitle,
            body: CustomMessage,
            data: { eventId: EventID },
          };

          // Send with retry logic
          const result = await sendBatchWithRetry(payload, batchIndex, EventID);
          if (result.data.some((ticket) => ticket.status === "error")) {
            throw new Error(
              `Batch ${batchIndex} failed: ${JSON.stringify(
                result.data.filter((t) => t.status === "error")
              )}`
            );
          }
          return result;
        });

        await Promise.all(sendPromises);

        // Log success
        await logNotification(
          notificationId,
          EventID,
          OrgID,
          DateTime,
          "Success"
        );

        // Delete SQS message
        await sqsClient.send(
          new DeleteMessageCommand({
            QueueUrl: QUEUE_URL,
            ReceiptHandle: record.receiptHandle,
          })
        );
        console.log(
          `Processed EventID: ${EventID} with ${followers.length} followers`
        );
      } catch (error) {
        console.error(
          `Error for EventID: ${EventID || "unknown"}`,
          error.message
        );
        batchItemFailures.push({ itemIdentifier: record.messageId });
        await logNotification(
          notificationId,
          EventID,
          OrgID,
          DateTime,
          "Fail",
          error.message
        );
      }
    })
  );

  return { batchItemFailures };
};

// Fetch followers with pagination from DynamoDB
// Inside index.mjs

// Fetch followers with pagination and token lookup
async function getFollowers(orgId) {
  const followers = [];
  const userIds = new Set(); // Avoid duplicates
  let lastKey = null;

  // Step 1: Query UserOrganizationFollow by OrgID using GSI
  do {
    try {
      const result = await dynamoDBClient.send(
        new QueryCommand({
          TableName: "UserOrganizationFollow",
          IndexName: "OrgIDIndex", // Assumed GSI with OrgID as PK
          KeyConditionExpression: "OrgID = :orgId",
          ExpressionAttributeValues: { ":orgId": { S: `ORG#${orgId}` } }, // Adjust prefix based on your input
          ExclusiveStartKey: lastKey,
          Limit: 1000, // Adjust based on read capacity
          ProjectionExpression: "UserID", // Only fetch UserID
        })
      );

      result.Items?.forEach((item) => userIds.add(item.UserID.S));
      lastKey = result.LastEvaluatedKey;
    } catch (error) {
      console.error(
        `Error querying UserOrganizationFollow for OrgID: ${orgId}`,
        error.message
      );
      throw new Error(`Failed to fetch followers: ${error.message}`);
    }
  } while (lastKey);

  if (userIds.size === 0) {
    console.warn(`No users found for OrgID: ${orgId}`);
    return followers;
  }

  console.log(`Found ${userIds.size} unique UserIDs for OrgID: ${orgId}`);

  // Step 2: Batch query TiktoPushTokens for tokens
  const userIdArray = Array.from(userIds);
  const tokenBatches = chunkArray(userIdArray, 100); // Batch size for BatchGetItem

  for (const batch of tokenBatches) {
    try {
      const keys = batch.map((userId) => ({ userId: { S: userId } }));
      const result = await dynamoDBClient.send(
        new BatchGetItemCommand({
          RequestItems: {
            TiktoPushTokens: {
              Keys: keys,
              ProjectionExpression: "token",
            },
          },
        })
      );

      const responses = result.Responses?.["TiktoPushTokens"] || [];
      responses.forEach((item) => {
        if (item.token?.S) {
          followers.push({ pushToken: item.token.S });
        }
      });

      // Handle unprocessed keys (if any)
      const unprocessed = result.UnprocessedKeys?.["TiktoPushTokens"]?.Keys;
      if (unprocessed?.length > 0) {
        console.warn(`Unprocessed keys in batch: ${unprocessed.length}`);
        // Retry logic could be added here if needed
      }
    } catch (error) {
      console.error(
        `Error fetching tokens for batch of ${batch.length} UserIDs`,
        error.message
      );
      throw new Error(`Token retrieval failed: ${error.message}`);
    }
  }

  console.log(`Retrieved ${followers.length} push tokens for OrgID: ${orgId}`);
  return followers;
}

// Send batch with exponential backoff retry
async function sendBatchWithRetry(payload, batchIndex, eventId) {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(EXPO_API_URL, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${EXPO_ACCESS_TOKEN}`,
        },
        body: JSON.stringify(payload),
      });

      const result = await response.json();
      if (response.ok && !result.errors) {
        console.log(
          `Batch ${batchIndex} for EventID: ${eventId} sent successfully`
        );
        return result;
      }

      const errorMsg = result.errors
        ? JSON.stringify(result.errors)
        : "Unknown Expo API error";
      throw new Error(`Expo API request failed: ${errorMsg}`);
    } catch (error) {
      if (attempt === MAX_RETRIES - 1) {
        console.error(
          `Final failure for batch ${batchIndex}, EventID: ${eventId}`,
          error.message
        );
        throw error;
      }
      const delay = 1000 * 2 ** attempt; // 1s, 2s, 4s
      console.warn(
        `Retry ${
          attempt + 1
        }/${MAX_RETRIES} for batch ${batchIndex}, EventID: ${eventId} after ${delay}ms`
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

// Log success or failure to DynamoDB
async function logNotification(
  notificationId,
  eventId,
  orgId,
  dateTime,
  status,
  errorMessage
) {
  const ttl = Math.floor(Date.now() / 1000) + 604800; // 1 week
  const params = {
    TableName: NOTIFICATION_TABLE,
    Item: {
      NotificationID: { S: notificationId },
      ...(eventId && { EventID: { S: eventId } }),
      ...(orgId && { OrgID: { S: orgId } }),
      ...(dateTime && { DateTime: { S: dateTime } }),
      Status: { S: status },
      ...(errorMessage && { ErrorMessage: { S: errorMessage } }),
      TTL: { N: ttl.toString() },
    },
  };

  try {
    await dynamoDBClient.send(new PutItemCommand(params));
    console.log(`Logged ${status} for NotificationID: ${notificationId}`);
  } catch (error) {
    console.error(
      `Failed to log NotificationID: ${notificationId}`,
      error.message
    );
    throw new Error(`DynamoDB logging failed: ${error.message}`);
  }
}

// Chunk array into batches
function chunkArray(array, size) {
  const result = [];
  for (let i = 0; i < array.length; i += size) {
    result.push(array.slice(i, i + size));
  }
  return result;
}
