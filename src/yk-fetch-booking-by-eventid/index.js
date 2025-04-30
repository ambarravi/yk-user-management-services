import {
  DynamoDBClient,
  QueryCommand,
  BatchGetItemCommand,
} from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";

const dynamoDBClient = new DynamoDBClient({ region: process.env.AWS_REGION });

export const handler = async (event) => {
  try {
    console.log("Input event:", JSON.stringify(event));

    const BOOKING_TABLE = "BookingDetails";
    const EVENT_TABLE = "EventDetails";
    const GSI_NAME = "EventID-index";

    // Parse input
    let body = JSON.parse(event.body);
    let eventId = body.eventID;

    if (!eventId) {
      return generateResponse(400, { message: "eventId is required" });
    }

    // Query bookings based on EventID
    const queryParams = {
      TableName: BOOKING_TABLE,
      IndexName: GSI_NAME,
      KeyConditionExpression: "EventID = :eventId",
      FilterExpression:
        "(attribute_not_exists(IsDeleted) OR IsDeleted = :notDeleted)",
      ExpressionAttributeValues: {
        ":eventId": { S: eventId },
        ":notDeleted": { BOOL: false },
      },
    };

    console.log("Query params:", JSON.stringify(queryParams));
    const queryResponse = await dynamoDBClient.send(
      new QueryCommand(queryParams)
    );
    const records = queryResponse.Items
      ? queryResponse.Items.map((item) => unmarshall(item))
      : [];

    console.log("Fetched Bookings:", records);

    if (records.length === 0) {
      return generateResponse(200, { records: [] });
    }

    // Fetch EventDetails for the EventID
    const batchParams = {
      RequestItems: {
        [EVENT_TABLE]: {
          Keys: [{ EventID: { S: eventId } }],
          ProjectionExpression:
            "EventID, EventTitle, EventLocation, EventDate, CategoryName, OrganizerName, ReadableEventID, Seats, ReservedSeats, TicketsBooked",
        },
      },
    };

    console.log("Batch get params:", JSON.stringify(batchParams));
    const batchResponse = await dynamoDBClient.send(
      new BatchGetItemCommand(batchParams)
    );
    const eventDetails = batchResponse.Responses[EVENT_TABLE]
      ? unmarshall(batchResponse.Responses[EVENT_TABLE][0])
      : null;

    console.log("Fetched Event Details:", eventDetails);

    // Enrich bookings with event details
    const enrichedRecords = records.map((record) => ({
      ...record,
      EventDetails: eventDetails || null,
    }));

    return generateResponse(200, { records: enrichedRecords });
  } catch (error) {
    console.error("Error processing request:", error);
    return generateResponse(500, {
      message: error.message || "Internal Server Error",
    });
  }
};

const generateResponse = (statusCode, body) => {
  return {
    statusCode,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
    body: JSON.stringify(body),
  };
};
