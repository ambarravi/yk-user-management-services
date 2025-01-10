import { DynamoDBClient, QueryCommand } from "@aws-sdk/client-dynamodb";

const region = process.env.AWS_REGION || "eu-west-1";
const dynamoDB = new DynamoDBClient({ region });

export async function handler(event) {
  const city = event.queryStringParameters?.city || "";
  const searchText = event.queryStringParameters?.searchText || "";

  if (!city) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "city is required" }),
    };
  }

  const params = {
    TableName: "City",
    IndexName: "City-index", // Use the GSI for querying by city
    KeyConditionExpression: "City = :city",
    ExpressionAttributeValues: {
      ":city": city,
    },
  };

  // Add FilterExpression based on searchText
  if (searchText) {
    params.FilterExpression =
      "contains(CityName, :searchText) OR begins_with(Shortform, :searchText)";
    params.ExpressionAttributeValues[":searchText"] = searchText;
  }

  try {
    const result = await dynamoDB.send(new QueryCommand(params));
    return {
      statusCode: 200,
      body: JSON.stringify(result.Items || []),
    };
  } catch (error) {
    console.error("Error querying DynamoDB:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Could not fetch cities" }),
    };
  }
}
