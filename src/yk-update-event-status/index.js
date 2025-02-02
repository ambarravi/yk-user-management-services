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
  AwaitingApproval: ["UnderReview", "Cancelled", "Deleted", "Approved"],
  Published: ["Cancelled"],
  Cancelled: ["Deleted"],
};

export const handler = async (event) => {
  try {
    // Check if the body is missing
    if (!event.body) {
      throw new Error(
        "Request body is missing. Ensure the request has a body."
      );
    }

    console.log("Received event:", event.body);
    const { eventID, eventStatus, role } = JSON.parse(event.body);

    // Ensure all required fields are present in the request
    if (!eventID || !eventStatus || !role) {
      throw new Error("Missing required fields: eventID, status, and role.");
    }

    const TABLE = process.env.EVENT_TABLE;
    if (!TABLE) {
      throw new Error("EVENT_TABLE environment variable is missing.");
    }

    // Fetch the existing event to check its current status
    const getParams = {
      TableName: TABLE,
      Key: { EventID: { S: eventID } },
    };

    const existingRecord = await dynamoDBClient.send(
      new GetItemCommand(getParams)
    );

    // If the event doesn't exist, return a specific error message
    if (!existingRecord.Item) {
      throw new Error(
        `Event with ID ${eventID} not found. Please check the eventID.`
      );
    }

    const currentStatus = existingRecord.Item.EventStatus?.S;
    console.log(
      `Current status: ${currentStatus}, Requested status: ${eventStatus}, Role: ${role}`
    );

    let allowedTransitions = STATUS_TRANSITIONS[currentStatus] || [];

    // Apply admin override logic
    if (role === "Admin" && ADMIN_OVERRIDES[currentStatus]) {
      allowedTransitions = [
        ...allowedTransitions,
        ...ADMIN_OVERRIDES[currentStatus],
      ];
    }

    // If the requested status isn't allowed based on current status, throw an error
    if (!allowedTransitions.includes(eventStatus)) {
      throw new Error(
        `Invalid status transition: Cannot change from ${currentStatus} to ${eventStatus}.`
      );
    }

    // Update the event's status in the database
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

    console.log(
      `Successfully updated event ${eventID} to status ${eventStatus}.`
    );
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
    console.error("Error updating status:", error.message);

    // Provide detailed error messages for different cases
    let errorMessage = "An unexpected error occurred.";
    if (error.message.includes("Missing required fields")) {
      errorMessage = error.message;
    } else if (error.message.includes("Event with ID")) {
      errorMessage = error.message;
    } else if (error.message.includes("Invalid status transition")) {
      errorMessage = error.message;
    } else if (error.message.includes("environment variable is missing")) {
      errorMessage = error.message;
    } else {
      errorMessage =
        "An unexpected error occurred while processing your request.";
    }

    return {
      statusCode: 500,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
      body: JSON.stringify({
        statusCode: 500,
        error: errorMessage,
      }),
    };
  }
};

function getCorsHeaders(origin) {
  console.log("in getCorsHeaders function");

  const allowedOrigins = [
    "http://localhost:3000",
    "https://dom5rgdes5ko4.cloudfront.net",
    "*",
  ];

  const isOriginAllowed = allowedOrigins.includes(origin);

  console.log("Allowed Origin:", isOriginAllowed);
  return {
    "Access-Control-Allow-Origin": isOriginAllowed
      ? origin
      : "http://localhost:3000",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, X-Amz-Date, X-Api-Key, X-Amz-Security-Token",
    "Access-Control-Allow-Methods": "OPTIONS, POST, GET, PUT, DELETE",
    "Access-Control-Allow-Credentials": "true",
  };
}
