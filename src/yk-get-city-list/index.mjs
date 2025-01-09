import { DynamoDBClient, QueryCommand } from "@aws-sdk/client-dynamodb";

const region = process.env.AWS_REGION || "eu-west-1"; // Default region
const dynamoDB = new DynamoDBClient({ region });

export async function handler(event) {
  const cityPrefix = event.queryStringParameters?.cityPrefix || "";
  console.log(params);
  if (!cityPrefix) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "cityPrefix is required" }),
    };
  }

  const params = {
    TableName: "City", // Ensure the correct table name
    IndexName: "CityName-index", // Ensure the correct GSI
    KeyConditionExpression: "CityName begins_with :cityPrefix",
    ExpressionAttributeValues: {
      ":cityPrefix": cityPrefix,
    },
  };

  console.log(params);
  try {
    const result = await dynamoDB.send(new QueryCommand(params));
    console.log("Äfter Result");
    console.log(result);
    const cities = result.Items || []; // Safe handling of result.Items
    console.log(cities);
    return {
      statusCode: 200,
      body: JSON.stringify(cities),
    };
  } catch (error) {
    console.error("Error querying DynamoDB:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Could not fetch city suggestions" }),
    };
  }
}
