import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

// Initialize DynamoDB clients
const client = new DynamoDBClient({ region: "eu-west-1" }); // Replace with your region, e.g., "us-east-1"
const dynamoDb = DynamoDBDocumentClient.from(client);

export const handler = async (event) => {
  let userId;
  try {
    const body = JSON.parse(event.body);
    userId = body.userId;
    if (!userId) {
      throw new Error("Missing userId in request body");
    }
  } catch (parseError) {
    console.error("Error parsing event body:", parseError);
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Invalid request body" }),
    };
  }

  const params = {
    TableName: "TiktoPushTokens",
    Key: {
      userId: userId, // Plain string value, DocumentClient handles conversion
    },
  };

  try {
    await dynamoDb.send(new DeleteCommand(params));
    console.log(`Successfully deleted item for userId: ${userId}`);
    return {
      statusCode: 200,
      body: JSON.stringify({ message: "Token unregistered" }),
    };
  } catch (error) {
    console.error("Error unregistering token:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "Failed to unregister token",
        details: error.message,
      }),
    };
  }
};
