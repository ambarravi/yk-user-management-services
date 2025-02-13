import { DynamoDBClient, QueryCommand } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";

const dynamoDBClient = new DynamoDBClient({ region: process.env.AWS_REGION });

export const handler = async (event) => {
  try {
    console.log("Input event:", JSON.stringify(event));
    const TABLE = "BookingDetails";
    const GSI_NAME = "UserId-EventID-index"; // Name of the Global Secondary Index
    let body = JSON.parse(event.body);

    // Access the 'userId' field
    let userId = body.userId;

    console.log("TABLE:", TABLE);
    console.log("GSI_NAME:", GSI_NAME);

    const queryParams = {
      TableName: TABLE,
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

    console.log("Query response:", queryResponse);

    const currentDate = new Date().toISOString(); // Get current date in ISO format

    const records = queryResponse.Items
      ? queryResponse.Items.map((item) => unmarshall(item))
      : [];

    // Filter records to include only future events
    const futureRecords = records.filter(
      (record) => record.EventDate && record.EventDate > currentDate
    );

    console.log("Filtered Future Records:", futureRecords);

    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
      body: JSON.stringify({
        records: futureRecords,
      }),
    };
  } catch (error) {
    console.error("Error processing request:", error);
    return {
      statusCode: 500,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
      body: JSON.stringify({
        message: error.message || "Internal Server Error",
      }),
    };
  }
};
