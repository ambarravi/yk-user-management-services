import { DynamoDBClient, QueryCommand } from "@aws-sdk/client-dynamodb";

const region = process.env.AWS_REGION || "eu-west-1"; // Default region
const dynamoDB = new DynamoDBClient({ region });

export async function handler(event) {
  const cityPrefix = event.queryStringParameters?.cityPrefix || "";
  console.log("Incoming Event:", JSON.stringify(event, null, 2)); // Debugging log
  if (!cityPrefix) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "cityPrefix is required" }),
    };
  }

  const params = {
    TableName: "City", // Your DynamoDB Table name
    KeyConditionExpression: "#city = :cityPrefix", // Use an appropriate key expression
    ExpressionAttributeNames: { "#city": "cityName" },
    ExpressionAttributeValues: { ":cityPrefix": { S: cityPrefix } }, // Ensure proper attribute type
  };

  try {
    const command = new QueryCommand(params);
    const result = await dynamoDB.send(command);

    return {
      statusCode: 200,
      body: JSON.stringify(result.Items || []),
    };
  } catch (error) {
    console.error("Error fetching city suggestions:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Could not fetch city suggestions" }),
    };
  }
}
