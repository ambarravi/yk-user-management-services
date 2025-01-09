import { DynamoDB } from "aws-sdk";

const dynamoDb = new DynamoDB.DocumentClient();

export async function handler(event) {
  const cityPrefix = event.queryStringParameters.cityPrefix;

  const params = {
    TableName: "CitiesTable", // Your DynamoDB Table name
    KeyConditionExpression: "#city begins_with :cityPrefix",
    ExpressionAttributeNames: { "#city": "cityName" },
    ExpressionAttributeValues: { ":cityPrefix": cityPrefix },
  };

  try {
    const result = await dynamoDb.query(params).promise();
    const cities = result.Items;
    return {
      statusCode: 200,
      body: JSON.stringify(cities),
    };
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Could not fetch city suggestions" }),
    };
  }
}
