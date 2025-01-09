import { DynamoDBClient, QueryCommand } from "@aws-sdk/client-dynamodb";

const dynamoDB = new DynamoDBClient({ region: "eu-west-1" });

export async function handler(event) {
  const cityPrefix = event.queryStringParameters?.cityPrefix || "";
  console.log(JSON.stringify(event));

  const params = {
    TableName: "City",
    IndexName: "CityName-index", // Query against the GSI
    KeyConditionExpression: "CityName begins_with :cityPrefix",
    ExpressionAttributeValues: {
      ":cityPrefix": cityPrefix,
    },
  };
  console.log(JSON.stringify(params));
  try {
    const command = new QueryCommand(params);
    const result = await dynamoDB.send(command);

    return {
      statusCode: 200,
      body: JSON.stringify(result.Items || []),
    };
  } catch (error) {
    console.error("Error querying cities:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Could not fetch city suggestions" }),
    };
  }
}
