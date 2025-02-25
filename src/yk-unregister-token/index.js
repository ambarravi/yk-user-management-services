import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

const client = new DynamoDBClient({});
const dynamoDb = DynamoDBDocumentClient.from(client);

export const handler = async (event) => {
  const { userId } = JSON.parse(event.body);

  const params = {
    TableName: "TiktoPushTokens",
    Key: { userId },
  };

  try {
    await dynamoDb.send(new DeleteCommand(params));
    return {
      statusCode: 200,
      body: JSON.stringify({ message: "Token unregistered" }),
    };
  } catch (error) {
    console.error("Error unregistering token:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Failed to unregister token" }),
    };
  }
};
