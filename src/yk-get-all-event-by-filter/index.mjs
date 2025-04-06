import { DynamoDBClient, ScanCommand } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";

const region = process.env.AWS_REGION || "eu-west-1";
const client = new DynamoDBClient({ region });

export async function handler(event) {
  console.log("Received event:", JSON.stringify(event));

  const parsedBody = event.body ? JSON.parse(event.body) : {};
  const limit = parseInt(parsedBody.limit) || 100; // Default limit
  const lastEvaluatedKey = parsedBody?.lastEvaluatedKey
    ? JSON.parse(parsedBody.lastEvaluatedKey)
    : null;

  console.log("Limit:", limit);
  console.log("LastEvaluatedKey:", lastEvaluatedKey);

  const params = {
    TableName: "EventDetails", // Table name
    //  FilterExpression: "#status <> :status", // Exclude records where Status is "Deleted"
    // ExpressionAttributeValues: {
    //   ":status": { S: "Deleted" },
    // },
    ProjectionExpression:
      "#eventID, #eventTitle, #eventDate, #eventStatus, #ticketsBooked, #seats, #readableEventID", // Required attributes
    ExpressionAttributeNames: {
      "#eventID": "EventID",
      "#readableEventID": "ReadableEventID",
      "#eventTitle": "EventTitle",
      "#eventDate": "EventDate",
      "#eventStatus": "EventStatus",
      "#ticketsBooked": "SeatsBooked",
      "#seats": "Seats",
    },
    Limit: limit, // Pagination limit
    ExclusiveStartKey: lastEvaluatedKey, // Continue from the last evaluated key
  };

  try {
    const command = new ScanCommand(params);
    const response = await client.send(command);
    console.log("DynamoDB Response:", response.Items?.length || 0);

    const unmarshalledItems =
      response.Items?.map((item) => unmarshall(item)) || [];

    // Ensure default values
    const itemsWithDefaults = unmarshalledItems.map((item) => ({
      ...item,
      Status: item.EventStatus || "AwaitingApproval",
      TicketsBooked: item.SeatsBooked || 0,
    }));

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({
        items: itemsWithDefaults,
        lastEvaluatedKey: response.LastEvaluatedKey
          ? JSON.stringify(response.LastEvaluatedKey)
          : null,
      }),
    };
  } catch (error) {
    console.error("Error scanning DynamoDB:", error);
    return {
      statusCode: 500,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({ error: "Error scanning data" }),
    };
  }
}
