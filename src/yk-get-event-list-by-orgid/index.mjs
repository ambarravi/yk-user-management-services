import { DynamoDBClient, QueryCommand } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";

const region = process.env.AWS_REGION || "eu-west-1";
const client = new DynamoDBClient({ region });

export async function handler(event) {
  if (!event.body) {
    throw new Error("Request body is missing.");
  }

  console.log("Input event body:", event.body);
  const parsedBody = JSON.parse(event.body);
  const orgID = parsedBody.orgID;
  const limit = parseInt(parsedBody.limit) || 100; // Default to 10
  const lastEvaluatedKey = parsedBody?.lastEvaluatedKey || null;
  console.log(lastEvaluatedKey);

  if (!orgID) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "orgID is required" }),
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*", // CORS headers
      },
    };
  }
  const params = {
    TableName: "EventDetails", // Your table name
    IndexName: "OrgID-index", // Name of the GSI
    KeyConditionExpression: "OrgID = :orgID", // Query by OrgID
    FilterExpression: "#status <> :status", // Exclude records where Status is "Deleted"
    ExpressionAttributeValues: {
      ":orgID": { S: orgID }, // Properly format the orgID as a string
      ":status": { S: "Deleted" }, // The status to exclude
    },
    ProjectionExpression:
      "#eventID, #eventTitle, #eventDate, #status, #ticketsBooked, #seats,#readableEventID", // Fetch only required attributes
    ExpressionAttributeNames: {
      "#eventID": "EventID",
      "#readableEventID": "ReadableEventID",
      "#eventTitle": "EventTitle",
      "#eventDate": "EventDate",
      "#status": "Status",
      "#ticketsBooked": "TicketsBooked",
      "#seats": "Seats",
    },
    Limit: limit, // Pagination limit
    ExclusiveStartKey: lastEvaluatedKey ? JSON.parse(lastEvaluatedKey) : null, // Continue from the last evaluated key
  };

  // Query DynamoDB with pagination
  async function queryDynamoDB() {
    try {
      const command = new QueryCommand(params);
      const response = await client.send(command);
      console.log("DynamoDB Response:", response.Items.length);
      if (response.Items.length === 0) {
        console.log("No items found for orgID:", orgID);
      }
      console.log("unmarshalledItems");
      const unmarshalledItems = response.Items.map((item) => unmarshall(item));

      // Ensure default values for Status and TicketsBooked if not found
      const itemsWithDefaults = unmarshalledItems.map((item) => ({
        ...item,
        Status: item.Status || "Pending for Approval", // Default to "Pending for Approval" if Status is not found
        TicketsBooked: item.TicketsBooked || 0, // Default to 0 if TicketsBooked is not found
      }));

      console.log("Query succeeded:", itemsWithDefaults);

      // Pagination: If there is more data, include the LastEvaluatedKey in the response
      const result = {
        statusCode: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*", // CORS headers
        },
        body: JSON.stringify({
          items: itemsWithDefaults || [],
          lastEvaluatedKey: response.LastEvaluatedKey
            ? JSON.stringify(response.LastEvaluatedKey)
            : null,
        }),
      };

      return result;
    } catch (error) {
      console.error("Error querying DynamoDB:", error);
      return {
        statusCode: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*", // CORS headers
        },
        body: JSON.stringify({ error: "Error querying data" }),
      };
    }
  }

  const response = await queryDynamoDB();
  return response;
}
