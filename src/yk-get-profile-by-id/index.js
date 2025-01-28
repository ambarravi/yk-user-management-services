import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";

const dynamoDBClient = new DynamoDBClient({ region: process.env.AWS_REGION });

export const handler = async (event) => {
  try {
    console.log("Input event:", JSON.stringify(event));
    const REGION = process.env.AWS_REGION;
    const TABLE = process.env.ORGANIZER_TABLE;
    let body = JSON.parse(event.body);

    // Access the 'username' field
    let username = body.username;

    console.log("TABLE:", TABLE);

    const getParams = {
      TableName: TABLE,
      Key: {
        OrganizerID: {
          S: username,
        },
      },
    };

    console.log("Get params:", JSON.stringify(getParams));

    const existingRecord = await dynamoDBClient.send(
      new GetItemCommand(getParams)
    );

    console.log("Existing record:", existingRecord);

    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
      body: JSON.stringify({
        record: existingRecord.Item,
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
