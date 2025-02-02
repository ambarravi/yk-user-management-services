import {
  DynamoDBClient,
  UpdateItemCommand,
  GetItemCommand,
} from "@aws-sdk/client-dynamodb";

const dynamoDBClient = new DynamoDBClient({ region: process.env.AWS_REGION });

const STATUS_TRANSITIONS = {
  AwaitingApproval: ["UnderReview", "Cancelled", "Deleted"],
  UnderReview: ["Approved", "Cancelled", "Deleted"],
  Approved: ["Published", "Cancelled", "Deleted"],
  Published: [], // Default: No transition
  Cancelled: ["Deleted"], // Default: Only Admin can delete
  Deleted: [], // No further updates allowed
};

const ADMIN_OVERRIDES = {
  Published: ["Cancelled"],
  Cancelled: ["Deleted"],
};

export const handler = async (event) => {
  try {
    if (!event.body) {
      throw new Error("Request body is missing.");
    }

    console.log("Received event:", event.body);
    const { eventID, status, role } = JSON.parse(event.body);

    if (!eventID || !status || !role) {
      throw new Error("eventID, status, and role are required.");
    }

    const TABLE = process.env.EVENT_TABLE;
    if (!TABLE) {
      throw new Error("EVENT_TABLE environment variable is missing.");
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
      throw new Error("Event not found.");
    }

    const currentStatus = existingRecord.Item.Status?.S;
    console.log(
      `Current status: ${currentStatus}, Requested status: ${status}, Role: ${role}`
    );

    let allowedTransitions = STATUS_TRANSITIONS[currentStatus] || [];

    // Apply admin override logic
    if (role === "Admin" && ADMIN_OVERRIDES[currentStatus]) {
      allowedTransitions = [
        ...allowedTransitions,
        ...ADMIN_OVERRIDES[currentStatus],
      ];
    }

    if (!allowedTransitions.includes(status)) {
      throw new Error(
        `Invalid status transition from ${currentStatus} to ${status}.`
      );
    }

    const updateParams = {
      TableName: TABLE,
      Key: { EventID: { S: eventID } },
      UpdateExpression: "SET #status = :status, #timestamp = :timestamp",
      ExpressionAttributeNames: {
        "#status": "Status",
        "#timestamp": `${status}Timestamp`,
      },
      ExpressionAttributeValues: {
        ":status": { S: status },
        ":timestamp": { S: new Date().toISOString() },
      },
    };

    await dynamoDBClient.send(new UpdateItemCommand(updateParams));

    console.log(`Successfully updated event ${eventID} to status ${status}.`);
    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "Status updated successfully",
        eventID,
        status,
      }),
    };
  } catch (error) {
    console.error("Error updating status:", error);
    return {
      statusCode: 400,
      body: JSON.stringify({ error: error.message }),
    };
  }
};
