import { DynamoDBClient, ScanCommand } from "@aws-sdk/client-dynamodb";

const region = process.env.AWS_REGION || "eu-west-1"; // Default region
const dynamoDB = new DynamoDBClient({ region });

export async function handler(event) {
  try {
    const params = {
      TableName: "City",
    };

    const result = await dynamoDB.send(new ScanCommand(params));
    console.log("Query result:", result);
    return {
      statusCode: 200,
      body: JSON.stringify(result.Items || []),
    };
  } catch (error) {
    console.error("Error:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Could not fetch city suggestions" }),
    };
  }
}
