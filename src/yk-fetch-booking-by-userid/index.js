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
    const GSI_NAME = "UserId-EventID-index";

    let body = JSON.parse(event.body);
    let userId = body.userId;
    let review = body.review || false; // Read 'review' flag, default is false

    // Query bookings based on UserId
    const queryParams = {
      TableName: BOOKING_TABLE,
      IndexName: GSI_NAME,
      KeyConditionExpression: "UserId = :userId",
      ExpressionAttributeValues: {
        ":userId": { S: userId },
      },
    };

    console.log("Query params:", JSON.stringify(queryParams));
    const queryResponse = await dynamoDBClient.send(
      new QueryCommand(queryParams)
    );
    const records = queryResponse.Items
      ? queryResponse.Items.map((item) => unmarshall(item))
      : [];

    const currentDate = new Date().toISOString();

    let filteredRecords;

    if (review) {
      // Fetch only past events for review
      filteredRecords = records.filter(
        (record) => record.EventDate && record.EventDate <= currentDate
      );
    } else {
      // Continue with existing logic for future bookings
      filteredRecords = records.filter(
        (record) => record.EventDate && record.EventDate > currentDate
      );
    }

    console.log("Filtered Records:", filteredRecords);

    if (filteredRecords.length === 0) {
      return generateResponse(200, { records: [] });
    }

    // Fetch unique EventIDs
    const eventIds = [
      ...new Set(filteredRecords.map((record) => record.EventID)),
    ];
    console.log("Unique Event IDs:", eventIds);

    // Batch fetch EventDetails for all EventIDs
    const batchParams = {
      RequestItems: {
        [EVENT_TABLE]: {
          Keys: eventIds.map((eventId) => ({ EventID: { S: eventId } })),
          ProjectionExpression:
            "EventID, EventTitle, EventLocation, EventDate, CategoryName, OrganizerName, ReadableEventID",
        },
      },
    };

    console.log("Batch get params:", JSON.stringify(batchParams));
    const batchResponse = await dynamoDBClient.send(
      new BatchGetItemCommand(batchParams)
    );
    const eventDetailsMap = batchResponse.Responses[EVENT_TABLE].reduce(
      (acc, item) => {
        const event = unmarshall(item);
        acc[event.EventID] = event;
        return acc;
      },
      {}
    );

    console.log("Fetched Event Details:", eventDetailsMap);

    // Attach event details to bookings
    const enrichedRecords = filteredRecords.map((record) => ({
      ...record,
      EventDetails: eventDetailsMap[record.EventID] || null,
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
