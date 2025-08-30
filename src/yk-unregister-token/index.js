import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

const client = new DynamoDBClient({ region: process.env.AWS_REGION }); // Replace with your region
const dynamoDb = DynamoDBDocumentClient.from(client);

export const handler = async (event) => {
  let userId, token;
  try {
    const body = JSON.parse(event.body);
    userId = body.userId;
    token = body.token; // Expect token as the sort key
    if (!userId || !token) {
      throw new Error("Missing userId or token in request body");
    }
    console.log("Received userId:", userId, "token:", token);
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
      userId: userId, // Partition key
      token: token, // Sort key
    },
  };

  console.log("Delete params:", JSON.stringify(params, null, 2));

  try {
    await dynamoDb.send(new DeleteCommand(params));
    console.log(
      `Successfully deleted item for userId: ${userId}, token: ${token}`
    );
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
