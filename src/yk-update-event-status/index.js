import {
  DynamoDBClient,
  UpdateItemCommand,
  GetItemCommand,
} from "@aws-sdk/client-dynamodb";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";

const dynamoDBClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const sqsClient = new SQSClient({ region: process.env.AWS_REGION });

const STATUS_TRANSITIONS = {
  AwaitingApproval: ["UnderReview", "Cancelled", "Deleted"],
  UnderReview: ["Approved", "Cancelled", "Deleted"],
  Approved: ["Published", "Cancelled", "Deleted"],
  Published: [],
  Cancelled: ["Deleted"],
  Deleted: [],
};

const ADMIN_OVERRIDES = {
  AwaitingApproval: ["UnderReview", "Cancelled", "Deleted", "Approved"],
  Published: ["Cancelled"],
  Cancelled: ["Deleted"],
};

export const handler = async (event) => {
  try {
    if (!event.body) {
      throw new Error(
        "Request body is missing. Ensure the request has a body."
      );
    }

    console.log("Received event:", event.body);
    const { eventID, eventStatus, role } = JSON.parse(event.body);

    if (!eventID || !eventStatus || !role) {
      throw new Error("Missing required fields: eventID, status, and role.");
    }

    const TABLE = process.env.EVENT_TABLE;
    const ORGANIZER_TABLE = "Organizer"; // Add Organizer table name
    const QUEUE_URL = process.env.EVENT_PUBLISH_QUEUE_URL;
    if (!TABLE || !QUEUE_URL) {
      throw new Error(
        "Missing required environment variables: EVENT_TABLE or EVENT_PUBLISH_QUEUE_URL."
      );
    }

    // Fetch existing event
    const getParams = {
      TableName: TABLE,
      Key: { EventID: { S: eventID } },
    };
    const existingRecord = await dynamoDBClient.send(
      new GetItemCommand(getParams)
    );
    if (!existingRecord.Item) {
      throw new Error(`Event with ID ${eventID} not found.`);
    }

    const currentStatus = existingRecord.Item.EventStatus?.S;
    console.log(
      `Current: ${currentStatus}, Requested: ${eventStatus}, Role: ${role}`
    );

    let allowedTransitions = STATUS_TRANSITIONS[currentStatus] || [];
    const roles = role.split(",").map((r) => r.trim().toLowerCase());
    const isAdmin = roles.includes("admin");
    if (isAdmin) {
      allowedTransitions = [
        ...allowedTransitions,
        ...(ADMIN_OVERRIDES[currentStatus] || []),
      ];
    }

    if (!allowedTransitions.includes(eventStatus)) {
      throw new Error(
        `Invalid transition: ${currentStatus} to ${eventStatus}.`
      );
    }

    // Update event status in DynamoDB
    const updateParams = {
      TableName: TABLE,
      Key: { EventID: { S: eventID } },
      UpdateExpression:
        "SET #eventstatus = :eventStatus, #timestamp = :timestamp",
      ExpressionAttributeNames: {
        "#eventstatus": "EventStatus",
        "#timestamp": `${eventStatus}Timestamp`,
      },
      ExpressionAttributeValues: {
        ":eventStatus": { S: eventStatus },
        ":timestamp": { S: new Date().toISOString() },
      },
    };
    await dynamoDBClient.send(new UpdateItemCommand(updateParams));
    console.log(`Updated event ${eventID} to ${eventStatus}.`);

    let eventDetails = {};
    // If status is "Published", handle both SQS and Organizer update
    if (eventStatus === "Published") {
      eventDetails = {
        eventID: existingRecord.Item.EventID?.S,
        orgId: existingRecord.Item.OrgID?.S,
        eventTitle: existingRecord.Item.EventTitle?.S,
        dateTime: existingRecord.Item.EventDate?.S,
        readableEventID: existingRecord.Item.ReadableEventID?.S,
        eventType: existingRecord.Item.EventType?.S,
      };

      if (!eventDetails.orgId) {
        throw new Error("OrgId not found in event record.");
      }

      // Increment publishedEvent count in Organizer table
      const updateOrganizerParams = {
        TableName: ORGANIZER_TABLE,
        Key: {
          OrganizerID: { S: eventDetails.orgId },
        },
        UpdateExpression:
          "SET #publishedEvent = if_not_exists(#publishedEvent, :start) + :inc",
        ExpressionAttributeNames: {
          "#publishedEvent": "publishedEvent",
        },
        ExpressionAttributeValues: {
          ":start": { N: "0" },
          ":inc": { N: "1" },
        },
      };
      await dynamoDBClient.send(new UpdateItemCommand(updateOrganizerParams));
      console.log(
        `Incremented publishedEvent count for organizer ${eventDetails.orgId}`
      );

      // Send to SQS (existing functionality)
      const sqsMessage = {
        QueueUrl: QUEUE_URL,
        MessageBody: JSON.stringify(eventDetails),
      };
      await sqsClient.send(new SendMessageCommand(sqsMessage));
      console.log(`Sent event ${eventID} to SQS queue.`);
    }

    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
      body: JSON.stringify({
        message: "Status updated successfully.",
        statusCode: 200,
        eventID,
        eventStatus,
      }),
    };
  } catch (error) {
    console.error("Error:", error.message);
    let errorMessage =
      error.message.includes("Missing required fields") ||
      error.message.includes("Event with ID") ||
      error.message.includes("Invalid transition") ||
      error.message.includes("environment variable") ||
      error.message.includes("OrgId not found")
        ? error.message
        : "An unexpected error occurred.";
    return {
      statusCode: 500,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
      body: JSON.stringify({ statusCode: 500, error: errorMessage }),
    };
  }
};
